Feature: Campaigns catch shared outbreaks and nothing else (brief §1.7 items 1, 2, 3, 7, 9)

  Scenario: With the plant on, a campaign opens on the sisters
    Given 60 KS-D1 vans on urban duty at depot S1
    When 6 of them raise a COOLING incident within one day
    Then exactly 1 campaign is open
    And its members are those 6 vans

  Scenario: Scattered decoys stay out
    Given 6 diesel vans at 6 different depots
    When each raises a COOLING incident on the same day
    Then no campaign is open

  Scenario: A same-depot van of another model stays out
    Given an open campaign at depot S1 for model KS-D1 with 5 sisters
    When 2 vans of another model at depot S1 raise COOLING incidents
    Then the campaign still has 5 members
    And exactly 1 campaign is open

  Scenario: The heatwave opens nothing
    Given the rest of the region is running 40 incidents per 1,000 van-days
    When 6 vans at one depot raise a COOLING incident within one day
    Then no campaign is open
    And their group is only watching

  Scenario: One more sister grows the campaign, never a second one
    Given an open campaign at depot S1 for model KS-D1 with 5 sisters
    When a 6th sister raises a COOLING incident a day later
    Then exactly 1 campaign is open
    And the campaign has 6 members

  Scenario: Duplicate or late notes never clone a member
    Given an open campaign at depot S1 for model KS-D1 with 5 sisters
    When a member raises a second incident, an earlier late incident, and a close
    Then the campaign still has 5 members

  Scenario: An override survives the next tick
    Given an open campaign at depot S1 for model KS-D1 with 6 sisters
    And the lead dismisses it as not an outbreak
    When 1 more sister raises a COOLING incident
    Then the campaign stays dismissed
    When 2 more sisters raise COOLING incidents
    Then the campaign is re-raised
