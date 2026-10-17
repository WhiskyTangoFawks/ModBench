# Record filter

A record filter is a `.sql` file in your workspace: one SELECT that returns a `form_key` column. The Plugins view's record tree then shows only the records it names, and the records that hold them. The record panel and Referenced By are never filtered. The filter gesture picks a `.sql` file, or opens a new one, and a code lens on a SQL document applies it or clears it.

The query reads the record index's views: one view for each record type, and a few fixed views. A filter sees the active plugins' records. A script reads the same views across every plugin the record index holds, and in a script, `medit.select('SELECT * FROM view_columns')` lists each view's columns.
