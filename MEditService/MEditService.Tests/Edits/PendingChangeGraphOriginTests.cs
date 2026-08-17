using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Edits;

namespace MEditService.Tests.Edits;

/// <summary>
/// #333 / ADR-0036: <see cref="PendingChangeGraph"/>'s two union rules must key on plugin identity
/// (origin + filename), not filename alone — otherwise two same-filename, different-origin plugins'
/// independent pending changes union into one component, and saving one group silently writes and
/// commits the other origin's untouched, unreviewed plugin (the #272 migration never reached this
/// module). Each test below isolates exactly one of the two rules; scenarios mirror the
/// #272/DuplicateFilenameSessionApiTests idiom — two origins sharing one plugin filename, each
/// running its own NextFormID sequence from the same ModKey, so FormKey text alone cannot
/// distinguish them.
/// </summary>
public sealed class PendingChangeGraphOriginTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static IReadOnlyList<(string Plugin, PreparedPluginSave Prepared)> NoResults() => [];

    private static PendingChange StageCreate(DuckDbPendingChangeService svc, string formKey, string plugin, string origin) =>
        svc.Upsert(new PendingChangeUpsert(
            formKey, plugin, "npc_",
            new Dictionary<string, JsonElement> { ["$create"] = J("null") },
            "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.CreateChangeType,
            ParentCell: null, PlacementGroup: null, Origin: origin))[0];

    private static PendingChange StageDelete(DuckDbPendingChangeService svc, string formKey, string plugin, string origin) =>
        svc.Upsert(new PendingChangeUpsert(
            formKey, plugin, "npc_",
            new Dictionary<string, JsonElement> { [PendingChangeConstants.DeleteFieldPath] = PendingChangeConstants.NullElement },
            "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.DeleteChangeType,
            ParentCell: null, PlacementGroup: null, Origin: origin))[0];

    private static PendingChange StageFieldEdit(
        DuckDbPendingChangeService svc, string formKey, string plugin, string origin, string field,
        IReadOnlyList<PendingFormRef>? formRefs = null) =>
        svc.Upsert(new PendingChangeUpsert(
            formKey, plugin, "npc_",
            new Dictionary<string, JsonElement> { [field] = J("\"new\"") },
            "user", null,
            new Dictionary<string, JsonElement> { [field] = J("\"old\"") },
            formRefs, ChangeType: PendingChangeConstants.FieldEditChangeType,
            ParentCell: null, PlacementGroup: null, Origin: origin))[0];

    // --- Rule 2 (ApplyCreatedRecordRule) + AC1 -----------------------------------------------

    // The issue's own repro: two independent $creates, same FormKey text, same plugin filename,
    // different origins (each running its own NextFormID sequence from the same ModKey).
    [Fact]
    public void IndependentCreatesAtSameFormKeyDifferentOrigin_AreTwoGroups()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        const string sharedFormKey = "000001:Shared.esp";

        StageCreate(svc, sharedFormKey, "Shared.esp", "ModA");
        StageCreate(svc, sharedFormKey, "Shared.esp", "ModB");

        Assert.Equal(2, svc.GetChangeGroups().Count);
    }

    // --- AC2: saving one origin's group must not touch or write the other's -----------------

    [Fact]
    public async Task SavingOneOriginsGroup_LeavesOtherOriginsCreateUntouchedAndUnwritten()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        const string sharedFormKey = "000001:Shared.esp";

        var modACreate = StageCreate(svc, sharedFormKey, "Shared.esp", "ModA");
        StageCreate(svc, sharedFormKey, "Shared.esp", "ModB");

        IReadOnlyDictionary<string, IReadOnlyList<PendingChange>>? captured = null;
        await svc.ExecuteGroupSaveAsync(modACreate.Id, byPlugin =>
        {
            captured = byPlugin;
            return Task.FromResult(NoResults());
        });

        Assert.NotNull(captured);
        Assert.Single(captured); // only ModA's column — ModB's plugin is never in the write set
        Assert.All(captured.Values, members => Assert.All(members, m => Assert.Equal("ModA", m.Origin)));

        var survivor = Assert.Single(svc.GetChanges());
        Assert.Equal("ModB", survivor.Origin);
    }

    // --- Rule 1 (ApplyLifecycleReferenceRule), pending-ref half + AC4 -------------------------

    // ModA's edit holds a pending FormLink to ModA's own $create; ModB independently stages the
    // identical (FormKey, Plugin, FieldPath) edit under a different origin, with no ref of its own.
    // Pre-fix, BuildNodeIndex's origin-blind key collides the two edits (last upsert wins), so the
    // create can union with the *wrong* origin's edit — group count alone would still read 2, so
    // this asserts membership, not just count.
    [Fact]
    public void PendingReferenceFromOneOrigin_EntanglesOnlyThatOriginsNode()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        const string createdFormKey = "000001:Shared.esp";
        const string referrerFormKey = "000002:Shared.esp";

        var created = StageCreate(svc, createdFormKey, "Shared.esp", "ModA");
        var modAEdit = StageFieldEdit(
            svc, referrerFormKey, "Shared.esp", "ModA", "aggression",
            [new PendingFormRef("aggression", "aggression", createdFormKey)]);
        var modBEdit = StageFieldEdit(svc, referrerFormKey, "Shared.esp", "ModB", "aggression");

        var groups = svc.GetChangeGroups();
        Assert.Equal(2, groups.Count);

        var createsGroup = svc.GetChanges(memberChangeId: created.Id);
        Assert.Equal(2, createsGroup.Count);
        Assert.Contains(createsGroup, c => c.Id == modAEdit.Id);
        Assert.DoesNotContain(createsGroup, c => c.Id == modBEdit.Id);

        var modBGroup = svc.GetChanges(memberChangeId: modBEdit.Id);
        Assert.Single(modBGroup);
    }

    // --- Rule 1, committed-ref half (LoadCommittedRefsToLifecycleTargets) + AC4 --------------

    // Mirrors the pending-ref case above but the entangling edge is a *committed* form_references
    // row (inserted directly, like DuckDbTestFactory's own committed-index tests) pointing at a
    // pending $delete, rather than a pending FormLink — pins that the newly-added source_origin
    // column on this query is actually wired through, not just declared.
    [Fact]
    public void CommittedReferenceToADeletedRecord_EntanglesOnlyThatOriginsNode()
    {
        var (svc, conn) = DuckDbTestFactory.MakePendingChangeServiceWithConnection();
        const string deletedFormKey = "000001:Shared.esp";
        const string referrerFormKey = "000002:Shared.esp";

        InsertCommittedFormReference(conn, referrerFormKey, "Shared.esp", "ModA", deletedFormKey, "aggression");

        var deleted = StageDelete(svc, deletedFormKey, "Shared.esp", "ModA");
        var modAEdit = StageFieldEdit(svc, referrerFormKey, "Shared.esp", "ModA", "aggression");
        var modBEdit = StageFieldEdit(svc, referrerFormKey, "Shared.esp", "ModB", "aggression");

        var groups = svc.GetChangeGroups();
        Assert.Equal(2, groups.Count);

        var deletesGroup = svc.GetChanges(memberChangeId: deleted.Id);
        Assert.Equal(2, deletesGroup.Count);
        Assert.Contains(deletesGroup, c => c.Id == modAEdit.Id);
        Assert.DoesNotContain(deletesGroup, c => c.Id == modBEdit.Id);

        var modBGroup = svc.GetChanges(memberChangeId: modBEdit.Id);
        Assert.Single(modBGroup);
    }

    private static void InsertCommittedFormReference(
        DuckDBConnection conn, string sourceFormKey, string sourcePlugin, string sourceOrigin,
        string targetFormKey, string fieldPath)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO form_references
                (source_form_key, source_plugin, source_origin, target_form_key, field_path, record_type, editor_id)
            VALUES ($1, $2, $3, $4, $5, 'npc_', NULL)
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = sourceFormKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = sourcePlugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = sourceOrigin });
        cmd.Parameters.Add(new DuckDBParameter { Value = targetFormKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = fieldPath });
        cmd.ExecuteNonQuery();
    }
}
