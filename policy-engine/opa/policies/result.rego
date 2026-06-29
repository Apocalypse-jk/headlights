package output

default allow_output := false

privacy_check(count) if {
    count == 0
}

privacy_check(count) if {
    count >= 10
}

allow_output if {
	input.status == "succeeded"
	input.from == "focus.mannheim.broker.bbmri.samply.de"

	input.body.totals.patient >= 100
	input.body.totals.diagnosis >= 10

	privacy_check(input.body.stratifiers.gender.female)
	privacy_check(input.body.stratifiers.gender.male)
	privacy_check(input.body.stratifiers.gender.other)

	every _, count in input.body.stratifiers.donor_age {
		privacy_check(count)
	}

}

allow_output if {
	input.status == "claimed"

}
