# MEditService.Queries

Queries. The read side: every read the front end asks for, answered from the record index, which no other box reads. It also sets and clears the record filter and rebuilds the index, which change only the derived store. It writes no system of record.
