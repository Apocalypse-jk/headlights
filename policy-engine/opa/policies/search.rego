package input

default allow_access := false

allow_access if {
	input.from == "focus.mannheim.broker.bbmri.samply.de"
}
