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

    internal static string NotHeld(string alias) => $"""
        NOT EXISTS (
            SELECT 1 FROM ({Held}) held
            WHERE held.child = {alias}.form_key AND held.plugin = {alias}.plugin AND held.origin = {alias}.origin)
        """;

    /// <summary>A FormID is the load position of the plugin its FormKey names, then the ID inside it;
    /// a FormKey whose plugin the load order does not hold sorts after every one it does.</summary>
    internal static string FormIdOrder(string formKey) => $"""
        (SELECT MIN(fo.load_order_idx) FROM {TableDdlBuilder.RegistrationsRelation} fo
         WHERE lower(fo.plugin) = lower(split_part({formKey}, ':', 2))) NULLS LAST,
        lower(split_part({formKey}, ':', 2)), split_part({formKey}, ':', 1)
        """;
}
