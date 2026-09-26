namespace MEditService.Index;

/// <summary>How xEdit's navigator nests and orders a plugin's records (ADR-0018): a record another
/// record holds is listed beneath its holder and nowhere else, and a group lists its records in
/// load-order FormID order.</summary>
internal static class NavigatorSql
{
    /// <summary>One row per record a record holds in the same plugin: a topic in its quest, a
    /// response in its topic, a placed reference in its cell, an exterior cell in its worldspace.</summary>
    internal const string Held = """
        SELECT plugin, origin, parent_form_key AS parent, child_form_key AS child FROM container_child
        UNION ALL
        SELECT plugin, origin, parent_cell, form_key FROM placement
        UNION ALL
        SELECT plugin, origin, parent_worldspace, cell_form_key FROM cell_location WHERE parent_worldspace IS NOT NULL
        """;

    /// <summary>Two CTEs for a <c>WITH RECURSIVE</c>: <c>held</c>, the holdings <paramref name="where"/>
    /// keeps, and <c>above_failure</c>, every record holding an unreadable one at any depth.</summary>
    internal static string AboveAFailure(string records, string where) => $"""
        held AS (SELECT plugin, origin, parent, child FROM ({Held}) h {where}),
        above_failure(plugin, origin, form_key) AS (
            SELECT held.plugin, held.origin, held.parent FROM held
            JOIN {records} f ON f.form_key = held.child AND f.plugin = held.plugin AND f.origin = held.origin
            WHERE f.parse_diagnosis IS NOT NULL
            UNION
            SELECT held.plugin, held.origin, held.parent FROM held
            JOIN above_failure a ON held.child = a.form_key AND held.plugin = a.plugin AND held.origin = a.origin
        )
        """;

    internal static string NotHeld(string alias) => $"""
        NOT EXISTS (
            SELECT 1 FROM ({Held}) held
            WHERE held.child = {alias}.form_key AND held.plugin = {alias}.plugin AND held.origin = {alias}.origin)
        """;

    /// <summary>A FormID is the load position of the plugin the game loads under the FormKey's
    /// filename, then its ID; a light plugin's FormIDs take the FE prefix, so they follow every full
    /// plugin's.</summary>
    internal static string FormIdOrder(string formKey)
    {
        var loaded = $"""
            FROM {TableDdlBuilder.ParticipatingRelation} fo WHERE lower(fo.plugin) = lower(split_part({formKey}, ':', 2))
            ORDER BY fo.load_order_idx DESC, fo.origin LIMIT 1
            """;
        return $"""
            (SELECT fo.is_light {loaded}) NULLS LAST, (SELECT fo.load_order_idx {loaded}) NULLS LAST,
            lower(split_part({formKey}, ':', 2)), split_part({formKey}, ':', 1)
            """;
    }
}
