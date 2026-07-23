package output

default allow_output := false

patient_count := object.get(object.get(input.body, "totals", {}), "patient", 0)
diagnosis_count := object.get(object.get(input.body, "totals", {}), "diagnosis", 0)
gender_counts := object.get(object.get(input.body, "stratifiers", {}), "gender", {})
female_count := object.get(gender_counts, "female", 0)
male_count := object.get(gender_counts, "male", 0)
other_count := object.get(gender_counts, "other", 0)

privacy_check(count) if {
    count == 0
}

privacy_check(count) if {
    count >= 10
}

allow_output if {
    input.status == "claimed"
}

allow_output if {
    input.status == "succeeded"
    input.from == "focus.proxy2.broker"

    patient_count >= 50
	diagnosis_count >= 50

	privacy_check(female_count)
	privacy_check(male_count)
	privacy_check(other_count)

	every _, count in input.body.stratifiers.donor_age {
		privacy_check(count)
	}

    every _, count in input.body.stratifiers.sample_kind {
		privacy_check(count)
	}
}

allow_output if {
    input.status == "succeeded"
    input.from == "focus.proxy2.broker"

    patient_count == 0
	diagnosis_count == 0
}
