package input

default allow_access := false

allow_access if {
    input.from == "spot.proxy1.broker"
    "focus.proxy2.broker" in input.to
}