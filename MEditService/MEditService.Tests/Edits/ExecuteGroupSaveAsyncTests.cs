using System.Text.Json;
using MEditService.Core.Edits;

namespace MEditService.Tests.Edits;

public sealed class ExecuteGroupSaveAsyncTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static IReadOnlyDictionary<string, SaveResult> NoResults() =>
        new Dictionary<string, SaveResult>();

    private static ChangeGroup StageGroupChange(DuckDbPendingChangeService svc, string plugin, string field = "aggression")
    {
        var members = new[]
        {
            new GroupMember("000001:Test.esp", plugin, "npc_", "field_edit",
                field, J("\"Unaggressive\""), J("\"Frenzied\""))
        };
        return svc.StageGroup("edit", null, members);
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
                Task.FromException<IReadOnlyDictionary<string, SaveResult>>(new IOException("disk full"))));

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
        var groupId = Guid.NewGuid();
        svc.Upsert(new PendingChangeUpsert("000001:Test.esp", "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null,
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") },
            formRefs, GroupId: groupId));

        await Assert.ThrowsAsync<IOException>(() =>
            svc.ExecuteGroupSaveAsync(groupId, _ =>
                Task.FromException<IReadOnlyDictionary<string, SaveResult>>(new IOException("disk full"))));

        var drained = svc.DrainForPlugin("A.esp");
        Assert.NotEmpty(drained.FormRefsByFormKey["000001:Test.esp"]);
    }

    // A6
    [Fact]
    public async Task WriteReceivesCorrectSnapshot()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        var groupId = Guid.NewGuid();
        svc.Upsert(new PendingChangeUpsert("000001:Test.esp", "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\""), ["name"] = J("\"Bob\"") },
            "user", null,
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\""), ["name"] = J("\"Alice\"") },
            GroupId: groupId));

        IReadOnlyDictionary<string, IReadOnlyList<PendingChange>>? captured = null;
        await svc.ExecuteGroupSaveAsync(groupId, byPlugin =>
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
        var groupId = Guid.NewGuid();
        svc.Upsert(new PendingChangeUpsert("000001:Test.esp", "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null, new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") },
            GroupId: groupId));
        svc.Upsert(new PendingChangeUpsert("000002:Test.esp", "B.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null, new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") },
            GroupId: groupId));

        await svc.ExecuteGroupSaveAsync(groupId, _ => Task.FromResult(NoResults()));

        Assert.Empty(svc.GetChanges(groupId: groupId));
    }

    // A8
    [Fact]
    public async Task DeleteChangesForGroup_CleansUpChangeGroupRow()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(svc, "A.esp");

        await svc.ExecuteGroupSaveAsync(group.Id, _ => Task.FromResult(NoResults()));

        Assert.DoesNotContain(svc.GetChangeGroups(), g => g.Id == group.Id);
    }

    // A9
    [Fact]
    public async Task WriteSucceeds_FormRefsDeleted()
    {
        var svc = DuckDbTestFactory.MakePendingChangeService();
        var formRefs = new[] { new PendingFormRef("aggression", "aggression", "000002:Ref.esp") };
        var groupId = Guid.NewGuid();
        svc.Upsert(new PendingChangeUpsert("000001:Test.esp", "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null,
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") },
            formRefs, GroupId: groupId));

        await svc.ExecuteGroupSaveAsync(groupId, _ => Task.FromResult(NoResults()));

        var drained = svc.DrainForPlugin("A.esp");
        Assert.Empty(drained.FormRefsByFormKey["000001:Test.esp"]);
    }
}
