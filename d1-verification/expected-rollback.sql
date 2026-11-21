-- Expected failure validates import rollback, not production Worker DB.batch.
INSERT INTO probe_nonces(nonce,expires) VALUES('fictional-rollback-marker',3000);
INSERT INTO probe_assertions(test,passed) VALUES('expected-failing-check',0);
