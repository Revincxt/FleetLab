"""Scenario representation for fleet replay exports."""

from adaptive_agent_lab.environment.scenario import Scenario


def scenario_payload(scenario: Scenario) -> dict[str, object]:
    return {
        "id": scenario.scenario_id,
        "width": scenario.map.width,
        "height": scenario.map.height,
        "horizon": scenario.horizon,
        "batteryCapacity": scenario.battery_capacity,
        "initialRobot": {
            "x": scenario.initial_robot.position.x,
            "y": scenario.initial_robot.position.y,
        },
        "obstacles": [
            {"x": position.x, "y": position.y}
            for position in sorted(scenario.map.obstacles)
        ],
        "chargingStations": [
            {"x": position.x, "y": position.y}
            for position in sorted(scenario.map.charging_stations)
        ],
        "orders": [
            {
                "id": order.order_id,
                "pickup": {"x": order.pickup.x, "y": order.pickup.y},
                "dropoff": {"x": order.dropoff.x, "y": order.dropoff.y},
                "releaseTime": order.release_time,
                "deadline": order.deadline,
                "priority": order.priority,
            }
            for order in scenario.orders
        ],
        "events": [
            {
                "time": event.time,
                "kind": event.kind.value,
                **(
                    {"position": {"x": event.position.x, "y": event.position.y}}
                    if event.position is not None
                    else {}
                ),
                **({"orderId": event.order_id} if event.order_id is not None else {}),
            }
            for event in scenario.event_tape
        ],
    }
