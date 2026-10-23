CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE INDEX molecules_idCode ON molecules (idCode);
