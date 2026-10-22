using MEditService.Codec.Schema;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Store;

namespace MEditService.RecordIndex;

/// <summary>How xEdit's navigator nests and orders a plugin's records (plugins.md, The tree,
/// stories 5 and 6), a group's records in load-order FormID order.</summary>
internal static class NavigatorSql
{
    /// <summary>One row per record a record holds in the same plugin: a topic in its quest, a
    /// response in its topic, a placed reference in its cell, an exterior cell in its worldspace.</summary>
    internal static string HeldIn(string schema) => $"SELECT plugin, origin, parent, child, slot FROM {schema}holdings";

    /// <summary>The <c>held</c> CTE the holdings reads below read: the holdings <paramref name="where"/>
    /// keeps. the planner pushes no join key into it, so a read about one plugin names the plugin here.</summary>
    internal static string HeldFor(RecordScope scope, string where) =>
        $"held AS (SELECT plugin, origin, parent, child, slot FROM ({scope.Held}) h {where})";

    /// <summary>What a cell holds in <c>held</c>, by <c>parent_cell</c>: a record held outside a placement group,
    /// such as its landscape or a navmesh, lists among the temporary ones as xEdit lists it.</summary>
    internal static readonly string CellChildren = $"""
        SELECT plugin, origin, parent AS parent_cell, child AS form_key,
               CASE WHEN slot = '{PersistentFlag.PersistentGroup}' THEN 'persistent' ELSE 'temporary' END AS placement_group
        FROM held
        """;

    /// <summary>What a record holds in <c>held</c> that no spatial read lists: not its placed references or its cells.</summary>
    internal static readonly string ContainerChildren =
        $"(SELECT * FROM held WHERE slot NOT IN ({HoldingSlots.Placed}, {HoldingSlots.TopCell}, {HoldingSlots.Exterior}))";

    /// <summary>Two CTEs for a <c>WITH RECURSIVE</c>: <see cref="HeldFor"/>'s <c>held</c>, and
    /// <c>above_failure</c>, every record holding an unreadable one at any depth.</summary>
    internal static string AboveAFailure(RecordScope scope, string where) =>
        Above(scope, where, "above_failure", "TRUE", "f.parse_diagnosis IS NOT NULL");

    /// <summary>As <see cref="AboveAFailure"/>, with <c>above_change</c>: every record holding one with
    /// a working-tree change <paramref name="keep"/> keeps, once per state, in <c>fact</c>.</summary>
    internal static string AboveAChange(RecordScope scope, string where, string keep) =>
        Above(scope, where, "above_change", "f.working_tree_state",
            $"f.working_tree_state <> '{WorkingTreeState.None.Stored()}'{keep}");

    // `f` is the record the walk climbs from, so a seed's condition and fact name it.
    private static string Above(RecordScope scope, string where, string name, string seedFact, string seedCondition) => $"""
        {HeldFor(scope, where)},
        {name}(plugin, origin, form_key, fact) AS (
            SELECT held.plugin, held.origin, held.parent, {seedFact} FROM held
            JOIN {scope.Records} f ON f.form_key = held.child AND f.plugin = held.plugin AND f.origin = held.origin
            WHERE {seedCondition}
            UNION
            SELECT held.plugin, held.origin, held.parent, a.fact FROM held
            JOIN {name} a ON held.child = a.form_key AND held.plugin = a.plugin AND held.origin = a.origin
        )
        """;

    // Reads `held`. Joined rather than a correlated NOT EXISTS, which the planner answers by materializing the records
    // beside it, bodies and all: a plugin's bodies outgrow the memory the record index is held to.
    internal static string Unheld(string alias) =>
        $" ANTI JOIN held holding ON holding.child = {alias}.form_key AND holding.plugin = {alias}.plugin AND holding.origin = {alias}.origin";

    /// <summary>A FormID is its filename's active load index, then its ID; a light plugin's take the
    /// FE prefix, so follow every full plugin's. Read off registrations, which land before the
    /// sweep.</summary>
    internal static string FormIdOrder(string formKeyPlugin, string formKey) => $"""
        (SELECT row(fo.is_light, fo.load_order_idx)
         FROM {TableDdlBuilder.RegistrationsRelation} fo
         WHERE fo.load_order_idx IS NOT NULL AND fo.plugin = {formKeyPlugin}) NULLS LAST,
        lower({formKeyPlugin}), {formKey}
        """;
}
