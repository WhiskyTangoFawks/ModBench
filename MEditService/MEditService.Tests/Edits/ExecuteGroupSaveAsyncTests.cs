using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Edits;

namespace MEditService.Tests.Edits;

public sealed class ExecuteGroupSaveAsyncTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static IReadOnlyList<(string Plugin, PreparedPluginSave Prepared)> NoResults() => [];

    private static ChangeGroup StageGroupChange(DuckDbPendingChangeService svc, string plugin, string field = "aggression")
    {
        var members = new[]
        {
            new GroupMember("000001:Test.esp", plugin, "npc_", "field_edit",
                field, J("\"Unaggressive\""), J("\"Frenzied\""))
        };
        return svc.StageGroup("edit", null, members);
    }

    /// <summary>
    /// Stages a genuinely entangled pair and returns a member change id naming their component.
    /// A group of more than one has to be *earned* under ADR-0028: sharing a group_id no longer
    /// makes changes travel together, so these tests build the dependency that does. Here that is
    /// edge rule 1 — an edit in <paramref name="dependentPlugin"/> holding a FormLink to a record
    /// only the pending $create in <paramref name="createPlugin"/> brings into existence.
    /// </summary>
    private static Guid StageEntangledPair(
        DuckDbPendingChangeService svc, string createPlugin = "A.esp", string dependentPlugin = "B.esp")
    {
        const string createdFormKey = "000001:Test.esp";
        var created = svc.Upsert(new PendingChangeUpsert(
            createdFormKey, createPlugin, "npc_",
            new Dictionary<string, JsonElement> { ["$create"] = J("null") },
            "user", null, [], FormRefs: null, ChangeType: "create"));

        svc.Upsert(new PendingChangeUpsert(
            "000002:Test.esp", dependentPlugin, "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null,
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") },
            [new PendingFormRef("aggression", "aggression", createdFormKey)]));

        return created[0].Id;
    }

    // A1
    [Fact]
    public async Task NoChanges_ReturnsNoChanges_WriteNotCalled()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        var callCount = 0;
        var unknownGroupId = Guid.NewGuid();

        var result = await svc.ExecuteGroupSaveAsync(unknownGroupId, _ =>
        {
            callCount++;
            return Task.FromResult(NoResults());
        });

        Assert.IsType<SaveGroupResult.NoChanges>(result);
        Assert.Equal(0, callCount);
    }

    // A2
    [Fact]
    public async Task WithChanges_WriteSucceeds_ClearsChanges()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(svc, "A.esp");

        var result = await svc.ExecuteGroupSaveAsync(group.Id, _ => Task.FromResult(NoResults()));

        Assert.IsType<SaveGroupResult.Saved>(result);
        Assert.Empty(svc.GetChanges(groupId: group.Id));
    }

    // A3
    [Fact]
    public async Task WriteThrows_ChangesRestored()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(svc, "A.esp");

        await Assert.ThrowsAsync<IOException>(() =>
            svc.ExecuteGroupSaveAsync(group.Id, _ =>
                Task.FromException<IReadOnlyList<(string Plugin, PreparedPluginSave Prepared)>>(new IOException("disk full"))));

        Assert.NotEmpty(svc.GetChanges(groupId: group.Id));
    }

    // A4
    [Fact]
    public async Task OnlyClearsGroupChanges_NotOtherGroups()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        var groupA = StageGroupChange(svc, "A.esp");
        var groupB = StageGroupChange(svc, "B.esp");

        await svc.ExecuteGroupSaveAsync(groupA.Id, _ => Task.FromResult(NoResults()));

        Assert.Empty(svc.GetChanges(groupId: groupA.Id));
        Assert.NotEmpty(svc.GetChanges(groupId: groupB.Id));
    }

    // A5
    [Fact]
    public async Task WriteThrows_FormRefsRestored()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        var formRefs = new[] { new PendingFormRef("aggression", "aggression", "000002:Ref.esp") };
        var staged = svc.Upsert(new PendingChangeUpsert("000001:Test.esp", "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null,
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") },
            formRefs));

        await Assert.ThrowsAsync<IOException>(() =>
            svc.ExecuteGroupSaveAsync(staged[0].Id, _ =>
                Task.FromException<IReadOnlyList<(string Plugin, PreparedPluginSave Prepared)>>(new IOException("disk full"))));

        var drained = svc.DrainForPlugin("A.esp");
        Assert.NotEmpty(drained.FormRefsByFormKey["000001:Test.esp"]);
    }

    // A6
    [Fact]
    public async Task WriteReceivesCorrectSnapshot()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        // Two fields of one record would be two groups now, not one — nothing entangles them
        // (ADR-0028). Stage a $create plus a field edit on the same record instead: the edit is on a
        // record the create brings into existence, so edge rule 2 makes them one component of two.
        var created = svc.Upsert(new PendingChangeUpsert("000001:Test.esp", "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["$create"] = J("null") },
            "user", null, [], FormRefs: null, ChangeType: "create"));
        svc.Upsert(new PendingChangeUpsert("000001:Test.esp", "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null,
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") }));

        IReadOnlyDictionary<string, IReadOnlyList<PendingChange>>? captured = null;
        await svc.ExecuteGroupSaveAsync(created[0].Id, byPlugin =>
        {
            captured = byPlugin;
            return Task.FromResult(NoResults());
        });

        Assert.NotNull(captured);
        Assert.True(captured.ContainsKey("A.esp"));
        Assert.Equal(2, captured["A.esp"].Count);
    }

    // A7
    [Fact]
    public async Task MultiPlugin_BothClearedOnSuccess()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        var memberId = StageEntangledPair(svc);

        await svc.ExecuteGroupSaveAsync(memberId, _ => Task.FromResult(NoResults()));

        Assert.Empty(svc.GetChanges(groupId: memberId));
        Assert.Empty(svc.GetChanges());
    }

    // A8
    [Fact]
    public async Task DeleteChangesForGroup_CleansUpChangeGroupRow()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(svc, "A.esp");

        await svc.ExecuteGroupSaveAsync(group.Id, _ => Task.FromResult(NoResults()));

        // Asserting DoesNotContain(g.Id == group.Id) would now pass vacuously — a derived group's id
        // is a member change id, so a saved group's id can never match anything anyway. Assert the
        // group is gone outright.
        Assert.Empty(svc.GetChangeGroups());
    }

    // A9
    [Fact]
    public async Task WriteSucceeds_FormRefsDeleted()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        var formRefs = new[] { new PendingFormRef("aggression", "aggression", "000002:Ref.esp") };
        var staged = svc.Upsert(new PendingChangeUpsert("000001:Test.esp", "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null,
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") },
            formRefs));

        await svc.ExecuteGroupSaveAsync(staged[0].Id, _ => Task.FromResult(NoResults()));

        var drained = svc.DrainForPlugin("A.esp");
        Assert.Empty(drained.FormRefsByFormKey["000001:Test.esp"]);
    }

    // A10 — the exact scenario #35 describes: the file is already moved (first half
    // succeeded) when the DB commit (second half) fails. Closing the connection inside
    // prepareAll — after DeleteChangesForGroup but before CommitFiles/CommitAsync — makes
    // txn.CommitAsync() fail for real, without disturbing the file move itself.
    [Fact]
    public async Task DbCommitFails_AfterFileAlreadyMoved_RollsBackFile()
    {
        using var conn = new DuckDBConnection("DataSource=:memory:");
        conn.Open();
        var svc = new DuckDbPendingChangeService(conn);
        var group = StageGroupChange(svc, "A.esp");

        var finalPath = Path.GetTempFileName();
        File.WriteAllText(finalPath, "original-content");
        var tmpDir = Path.Combine(Path.GetTempPath(), ".medit_tmp_" + Path.GetRandomFileName());
        Directory.CreateDirectory(tmpDir);
        var tmpPath = Path.Combine(tmpDir, "A.esp");
        File.WriteAllText(tmpPath, "new-content");
        var prepared = new PreparedPluginSave(tmpPath, finalPath, new SaveResult(string.Empty, [], [], [], []));

        try
        {
            await Assert.ThrowsAnyAsync<Exception>(() =>
                svc.ExecuteGroupSaveAsync(group.Id, _ =>
                {
                    conn.Close();
                    return Task.FromResult<IReadOnlyList<(string, PreparedPluginSave)>>([("A.esp", prepared)]);
                }));

            Assert.Equal("original-content", File.ReadAllText(finalPath));
            Assert.False(Directory.Exists(tmpDir)); // Dispose() cleaned up the tmp dir even on the rollback path
        }
        finally
        {
            File.Delete(finalPath);
            if (Directory.Exists(tmpDir)) Directory.Delete(tmpDir, recursive: true);
        }
    }
}
