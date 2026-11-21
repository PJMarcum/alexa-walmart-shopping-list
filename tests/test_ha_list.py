import pytest
from walmart_cart.ha_list import HaListError, consume, find_list_entity, read_open_items


STATES = [
    {"entity_id": "todo.shopping_list", "attributes": {"friendly_name": "Shopping list"}},
    {
        "entity_id": "todo.you_example_com_grocery",
        "attributes": {"friendly_name": "you@example.com grocery"},
    },
    {
        "entity_id": "todo.you_example_com_walmart",
        "attributes": {"friendly_name": "you@example.com walmart"},
    },
]


class FakeClient:
    """Stands in for HA. Records calls and can be told to fail."""

    def __init__(self, items=None, states=None, fail_times=0, drop_writes=False):
        self.items = list(items or [])
        self.states = states if states is not None else STATES
        self.fail_times = fail_times
        self.drop_writes = drop_writes
        self.calls = []
        self.reloads = 0

    def get_states(self):
        return self.states

    def reload_config_entry(self, entity_id):
        self.reloads += 1

    def call_service(self, domain, service, data, return_response=False):
        self.calls.append((domain, service, dict(data)))
        if self.fail_times > 0:
            self.fail_times -= 1
            raise OSError("500 Internal Server Error")
        if service == "get_items":
            return {"service_response": {data["entity_id"]: {"items": self.items}}}
        if self.drop_writes:
            return {}
        if service == "update_item":
            for item in self.items:
                if item["summary"].lower() == str(data["item"]).lower():
                    item["status"] = data.get("status", item["status"])
        if service == "remove_completed_items":
            self.items = [i for i in self.items if i["status"] != "completed"]
        return {}


def test_finds_the_walmart_entity_by_friendly_name():
    # Global constraint: never match on entity_id, which carries an unstable
    # HA area prefix.
    assert find_list_entity(STATES) == "todo.you_example_com_walmart"


def test_match_is_case_insensitive():
    states = [{"entity_id": "todo.x", "attributes": {"friendly_name": "acct WALMART"}}]
    assert find_list_entity(states) == "todo.x"


def test_missing_entity_raises():
    with pytest.raises(HaListError, match="no todo entity"):
        find_list_entity([STATES[0]])


def test_ignores_non_todo_entities():
    states = [{"entity_id": "sensor.walmart", "attributes": {"friendly_name": "walmart"}}]
    with pytest.raises(HaListError):
        find_list_entity(states)


def test_reads_only_open_items():
    client = FakeClient(items=[
        {"summary": "Pickles", "status": "needs_action"},
        {"summary": "Milk", "status": "completed"},
        {"summary": "Hamburger meat", "status": "needs_action"},
    ])
    assert read_open_items(client, "todo.x") == ["Pickles", "Hamburger meat"]


def test_read_retries_through_an_intermittent_500():
    # Measured: two 500s on first contact, then twelve clean calls.
    client = FakeClient(items=[{"summary": "Pickles", "status": "needs_action"}],
                        fail_times=2)
    assert read_open_items(client, "todo.x") == ["Pickles"]


def test_read_gives_up_after_persistent_failure():
    client = FakeClient(fail_times=99)
    with pytest.raises(HaListError, match="could not read"):
        read_open_items(client, "todo.x")


def test_consume_completes_then_clears():
    client = FakeClient(items=[
        {"summary": "Pickles", "status": "needs_action"},
        {"summary": "Milk", "status": "needs_action"},
    ])
    result = consume(client, "todo.x", ["Pickles"])
    assert result["completed"] == ["Pickles"]
    assert result["failed"] == []
    assert result["cleared"] is True
    assert [i["summary"] for i in client.items] == ["Milk"]
    services = [c[1] for c in client.calls]
    assert "remove_item" not in services  # returns 500 on this integration


def test_consume_matches_case_insensitively():
    # Amazon title-cases what it stores.
    client = FakeClient(items=[{"summary": "Pickles", "status": "needs_action"}])
    result = consume(client, "todo.x", ["pickles"])
    assert result["completed"] == ["pickles"]


def test_consume_reports_failure_and_leaves_the_item_when_the_write_is_lost():
    # Review Focus 2: a lost write must not be reported as success.
    client = FakeClient(
        items=[{"summary": "Pickles", "status": "needs_action"}], drop_writes=True
    )
    result = consume(client, "todo.x", ["Pickles"])
    assert result["failed"] == ["Pickles"]
    assert result["completed"] == []
    assert [i["summary"] for i in client.items] == ["Pickles"]


def test_consume_of_an_empty_selection_does_nothing():
    client = FakeClient(items=[{"summary": "Pickles", "status": "needs_action"}])
    result = consume(client, "todo.x", [])
    assert result == {"completed": [], "failed": [], "cleared": False}
    assert client.calls == []


class ReadFailsAfterWrite(FakeClient):
    """Accepts writes but 500s on every read.

    consume() does no read before writing, so its first get_items IS the
    read-back. Failing every read is what reproduces the stranded state:
    items marked complete, the clear never attempted, nobody told.
    """

    def __init__(self, items=None, states=None):
        super().__init__(items=items, states=states)

    def call_service(self, domain, service, data, return_response=False):
        if service == "get_items":
            self.calls.append((domain, service, dict(data)))
            raise OSError("500 Internal Server Error")
        return super().call_service(domain, service, data, return_response)


def test_consume_reports_failure_rather_than_raising_when_read_back_dies():
    # Review Focus 2. The post-write read is the exact intermittent-500
    # condition this module exists to absorb, so it must not escape and
    # strand items marked complete but uncleared with nobody notified.
    client = ReadFailsAfterWrite(items=[{"summary": "Milk", "status": "needs_action"}])
    result = consume(client, "todo.x", ["Milk"])
    assert result["failed"] == ["Milk"]
    assert result["completed"] == []
    assert result["cleared"] is False


class ShapedClient(FakeClient):
    """Returns a specific get_items response shape."""

    def __init__(self, payload):
        super().__init__(items=[])
        self._payload = payload

    def call_service(self, domain, service, data, return_response=False):
        if service == "get_items":
            return self._payload
        return {}


ITEMS = [{"summary": "Milk", "status": "needs_action"}]


def test_reads_the_service_response_wrapper_shape():
    c = ShapedClient({"service_response": {"todo.x": {"items": ITEMS}}})
    assert read_open_items(c, "todo.x") == ["Milk"]


def test_reads_the_bare_entity_keyed_shape():
    c = ShapedClient({"todo.x": {"items": ITEMS}})
    assert read_open_items(c, "todo.x") == ["Milk"]


def test_reads_a_payload_mixing_counters_with_the_response():
    # The live failure: AppDaemon's call_service returned a dict whose values
    # were not all dicts, so iterating and calling .get on each one raised
    # "'int' object has no attribute 'get'".
    c = ShapedClient({"changed_states": 0, "todo.x": {"items": ITEMS}})
    assert read_open_items(c, "todo.x") == ["Milk"]


def test_reads_the_response_key_shape():
    c = ShapedClient({"response": {"todo.x": {"items": ITEMS}}})
    assert read_open_items(c, "todo.x") == ["Milk"]


def test_an_unrecognised_shape_raises_naming_what_it_saw():
    c = ShapedClient({"changed_states": 0, "other": 7})
    with pytest.raises(HaListError) as err:
        read_open_items(c, "todo.x")
    # The message must carry the shape, or the next person debugs it blind.
    assert "changed_states" in str(err.value) or "shape" in str(err.value).lower()


def test_a_non_dict_payload_raises_rather_than_crashing():
    with pytest.raises(HaListError):
        read_open_items(ShapedClient([1, 2, 3]), "todo.x")


def test_reads_appdaemons_real_websocket_envelope():
    """The actual shape AppDaemon returns, captured from the live add-on.

    It hands back the raw websocket envelope rather than the service
    response, so the items sit several levels down under 'result'. The error
    message from the previous attempt is what revealed this:
    "keys were ['ad_duration', 'ad_status', 'id', 'result', 'success', 'type']".
    """
    c = ShapedClient({
        "ad_duration": 0.01,
        "ad_status": "OK",
        "id": 7,
        "success": True,
        "type": "result",
        "result": {
            "context": {"id": "abc"},
            "response": {"todo.x": {"items": ITEMS}},
        },
    })
    assert read_open_items(c, "todo.x") == ["Milk"]


def test_reads_items_nested_directly_under_result():
    c = ShapedClient({"success": True, "result": {"todo.x": {"items": ITEMS}}})
    assert read_open_items(c, "todo.x") == ["Milk"]


def test_deep_search_is_bounded_and_still_reports_a_bad_shape():
    deep = {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"items": ITEMS}}}}}}}}
    with pytest.raises(HaListError):
        read_open_items(ShapedClient(deep), "todo.x")
