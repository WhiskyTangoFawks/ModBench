namespace MEditService.Index;

/// <summary>How xEdit's navigator nests and orders a plugin's records (plugins.md, The tree,
/// stories 5 and 6), a group's records in load-order FormID order.</summary>
internal static class NavigatorSql
{
    /// <summary>One row per record a record holds in the same plugin: a topic in its quest, a
    /// response in its topic, a placed reference in its cell, an exterior cell in its worldspace.</summary>
    internal static readonly string Held = HeldIn("");

    internal static string HeldIn(string schema) => $"""
        SELECT plugin, origin, parent_form_key AS parent, child_form_key AS child,
               CAST(NULL AS VARCHAR) AS placement_group FROM {schema}container_child
        UNION ALL
        SELECT plugin, origin, parent_cell, form_key, placement_group FROM {schema}placement
        UNION ALL
        SELECT plugin, origin, parent_worldspace, cell_form_key, NULL FROM {schema}cell_location WHERE parent_worldspace IS NOT NULL
        """;

    /// <summary>What a cell holds, by <c>parent_cell</c>: a record held outside a placement group,
    /// such as its landscape or a navmesh, lists among the temporary ones as xEdit lists it.</summary>
    internal static readonly string CellChildren = $"""
        SELECT plugin, origin, parent AS parent_cell, child AS form_key,
               COALESCE(placement_group, 'temporary') AS placement_group
        FROM ({Held})
        """;

    /// <summary>Two CTEs for a <c>WITH RECURSIVE</c>: <c>held</c>, the holdings <paramref name="where"/>
    /// keeps, and <c>above_failure</c>, every record holding an unreadable one at any depth.</summary>
    internal static string AboveAFailure(RecordScope scope, string where) => $"""
        held AS (SELECT plugin, origin, parent, child FROM ({scope.Held}) h {where}),
        above_failure(plugin, origin, form_key) AS (
            SELECT held.plugin, held.origin, held.parent FROM held
            JOIN {scope.Records} f ON f.form_key = held.child AND f.plugin = held.plugin AND f.origin = held.origin
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

    /// <summary>A FormID is its filename's active load index, then its ID; a light plugin's take the
    /// FE prefix, so follow every full plugin's. Read off registrations, which land before the
    /// sweep.</summary>
    internal static string FormIdOrder(string formKey) => $"""
        (SELECT row(fo.is_light, fo.load_order_idx)
         FROM {TableDdlBuilder.RegistrationsRelation} fo
         WHERE fo.load_order_idx IS NOT NULL AND fo.plugin = split_part({formKey}, ':', 2)) NULLS LAST,
        lower(split_part({formKey}, ':', 2)), split_part({formKey}, ':', 1)
        """;
}
