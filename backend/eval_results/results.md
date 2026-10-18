# Paradox evaluation

20 sampled worlds per (case × true culprit); identical worlds for every policy. Prototype measurements on synthetic cases.

## Policies (RQ1, RQ2)

| case | policy | runs | accuracy | resolved in budget | wrong conclusions | mean cost | mean actions | mean confidence (solved) | accuracy of solved |
|---|---|---|---|---|---|---|---|---|---|
| case001 | eig | 60 | 0.67 | 0.72 | 3 | 7.57 | 4.65 | 0.95 | 0.93 |
| case001 | fixed | 60 | 0.67 | 0.70 | 2 | 8.78 | 6.10 | 0.95 | 0.95 |
| case001 | random | 60 | 0.53 | 0.63 | 6 | 9.12 | 5.53 | 0.94 | 0.84 |
| case002 | eig | 80 | 0.74 | 0.75 | 1 | 7.53 | 4.34 | 0.95 | 0.98 |
| case002 | fixed | 80 | 0.62 | 0.62 | 0 | 10.40 | 6.14 | 0.96 | 1.00 |
| case002 | random | 80 | 0.59 | 0.60 | 1 | 11.69 | 6.08 | 0.95 | 0.98 |
| all | eig | 140 | 0.71 | 0.74 | 4 | 7.54 | 4.47 | 0.95 | 0.96 |
| all | fixed | 140 | 0.64 | 0.66 | 2 | 9.71 | 6.12 | 0.95 | 0.98 |
| all | random | 140 | 0.56 | 0.61 | 7 | 10.59 | 5.84 | 0.94 | 0.92 |

## Contradiction-aware sufficiency ablation (RQ3)

| configuration | accuracy | wrong conclusions | mean cost |
|---|---|---|---|
| contradiction-aware (default) | 0.71 | 4 | 7.54 |
| contradictions ignored | 0.73 | 4 | 7.46 |

## Scripted demo variants

| case | truth | outcome | correct | cost | sequence |
|---|---|---|---|---|---|
| case001 | H2 | solved | True | 5 | act_lab_door → act_entrance_log → act_maint_log |
| case001 | H3 | solved | True | 3 | act_lab_door → act_meeting |
| case002 | HE | solved | True | 6 | act_archive_door → act_desk_camera → act_badge_audit |
| case002 | HF | solved | True | 4 | act_archive_door → act_badge_audit |

## Graph perturbations (RQ4)

| case | perturbation | baseline sequence | perturbed sequence | eligibility change at start | contradiction change |
|---|---|---|---|---|---|
| case001 | seal_passage | act_lab_door → act_entrance_log → act_maint_log | act_lab_door → act_entrance_log → act_meeting | −act_maint_log | none |
| case001 | ben_revised_claim | act_lab_door → act_entrance_log → act_maint_log | act_lab_door → act_entrance_log → act_maint_log | none | −B:supported:st_ben_1 |
| case002 | dmitri_revised_claim | act_archive_door → act_desk_camera → act_badge_audit | act_archive_door → act_desk_camera → act_badge_audit | none | −B:explained:st_dmitri_1; +B:supported:st_dmitri_1 |
| case002 | seal_reading_room_door | act_archive_door → act_desk_camera → act_badge_audit | act_archive_door → act_badge_audit → act_hana → act_confront_esme | −act_desk_camera | −D:explained:; +A:unresolved:st_esme_1+st_esme_2; +C:unresolved:st_esme_1+st_hana_1 |

_Runtime 218.4s._
