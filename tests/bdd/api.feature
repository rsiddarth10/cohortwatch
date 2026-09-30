Feature: Viewers see less, and every view leaves a trail (brief §1.7 item 10)

  Scenario: A viewer cannot see precise locations or drivers
    Given a van at depot D-010 with a driver assigned
    When a viewer opens the van
    Then the depot shows only its code, region and a coarse geohash
    And no driver is shown
    When a lead opens the same van
    Then the lead sees the depot coordinates and the driver pseudonym

  Scenario: Every view is audited
    Given a viewer is logged in
    When the viewer opens the depot queue, a campaign and a vehicle chart
    Then 3 audit rows are written with who, role and what was viewed
    And 3 audit events wait in the outbox for audit.v1
