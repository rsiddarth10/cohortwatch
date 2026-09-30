Feature: The workshop queue ranks real risk, and repairs are confirmed (brief §1.7 items 5, 6, 8)

  Scenario: Outbreak vans and the runaway rank above loud-but-stable vans
    Given a depot with 3 bays
    And a loud-but-stable van with 40 fault codes a day and a flat trend
    And 2 members of a COOLING campaign of 18 vans that are getting worse
    And a runaway van about 6 h from its limit
    When the queue is built
    Then the runaway is rank 1
    And both campaign members rank above the loud-but-stable van
    And the loud-but-stable van does not get a bay today

  Scenario: The runaway jumps to the top with a critical reason
    Given a depot queue with 5 vans that are getting worse
    When a van turns runaway with 9 h to its limit
    Then it is rank 1 with the reason "runaway: ≈ 9 h to 110 °C"
    And it gets a bay today

  Scenario: The repaired van is confirmed fixed and the campaign closes only when all members are fixed
    Given an open COOLING campaign with 3 members
    When 2 members are repaired and their next 12 driven hours sit inside their normal
    Then those repairs are FIXED
    And the campaign stays open with 2 of 3 fixed
    When the third member's repair shows 24 driven hours still outside its normal
    Then that repair is NOT_FIXED
    And that van is back in the queue with "did not hold"
    And the campaign stays open
    When the third member is repaired again and its readings return to normal
    Then the campaign is closed
