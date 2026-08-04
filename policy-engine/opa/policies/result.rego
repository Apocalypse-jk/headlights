package output

default allow_output := false

patient_count := object.get(object.get(input.body, "totals", {}), "patient", 0)
diagnosis_count := object.get(object.get(input.body, "totals", {}), "diagnosis", 0)
gender_counts := object.get(object.get(input.body, "stratifiers", {}), "gender", {})
female_count := object.get(gender_counts, "female", 0)
male_count := object.get(gender_counts, "male", 0)
other_count := object.get(gender_counts, "other", 0)

# During the output check, the policy proxy attaches the originally allowed
# input task as input.request_context. This lets the result policy evaluate both
# the result and properties of the search request that caused it.
original_request := object.get(input, "request_context", {})
original_request_found := object.get(input, "request_context_found", false)

# The original task metadata is available here. Example fields for later rules:
# requested_source := object.get(original_request_metadata, "source", "")
# requested_purpose := object.get(original_request_metadata, "purpose", "")
original_request_metadata := object.get(original_request, "metadata", {})

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
	original_request_found

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
	original_request_found

    original_request_metadata == "project:superuser"
}
