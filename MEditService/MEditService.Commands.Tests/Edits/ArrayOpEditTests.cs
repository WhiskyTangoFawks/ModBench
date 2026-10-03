using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

/// <summary>An array op is computed server-side from the record's current value, never
/// round-tripped as a client-computed whole array; the envelope is <c>value</c> itself, told apart
/// by shape.</summary>
public sealed class ArrayOpEditTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;
    [Fact]
    public void ArrayAdd_NestedArrayInAStruct_LandsAtTheArraysOwnPath()
    {
        using var fixture = ContainerMod(out var container);

        var result = fixture.EditHandler.Edit(fixture.Plugin, container.ToString(), AddAt(Member("Destructible"), Member("Stages")));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(1, Stages(fixture, container).GetArrayLength());
    }

    [Fact]
    public void ArrayRemove_NestedArrayElement_RemovesAtTheRealPath()
    {
        using var fixture = ContainerMod(out var container);
        var seed = fixture.EditHandler.Set(fixture.Plugin, container.ToString(), "Destructible",
            Json("""{"Stages": [{"HealthPercent": 10}, {"HealthPercent": 20}]}"""));
        Assert.True(seed.Applied, seed.Message);

        var result = fixture.EditHandler.Edit(fixture.Plugin, container.ToString(), RemoveAt(Member("Destructible"), Member("Stages"), At(0)));

        Assert.True(result.Applied, result.Message);
        var stages = Stages(fixture, container);
        Assert.Equal(1, stages.GetArrayLength());
        Assert.Equal(20, stages[0].GetProperty("HealthPercent").GetByte());
    }

    [Fact]
    public void ArrayMoveDown_NestedArrayElement_MovesAtTheRealPath()
    {
        using var fixture = ContainerMod(out var container);
        var seed = fixture.EditHandler.Set(fixture.Plugin, container.ToString(), "Destructible",
            Json("""{"Stages": [{"HealthPercent": 10}, {"HealthPercent": 20}]}"""));
        Assert.True(seed.Applied, seed.Message);

        var result = fixture.EditHandler.Edit(fixture.Plugin, container.ToString(), MoveTo(1, Member("Destructible"), Member("Stages"), At(0)));

        Assert.True(result.Applied, result.Message);
        var stages = Stages(fixture, container);
        Assert.Equal(2, stages.GetArrayLength());
        Assert.Equal(20, stages[0].GetProperty("HealthPercent").GetByte());
        Assert.Equal(10, stages[1].GetProperty("HealthPercent").GetByte());
    }

    // ── An array op reuses ColumnSpec.Apply unchanged, so it inherits
    // the nested write path exactly as any other whole-value write does ────────────────────────

    [Fact]
    public void ArrayMoveDown_ArrayContainsElementWithUnsetReadOnlyNestedField_StillApplies()
    {
        // Seeds [QuestLocationAlias, QuestReferenceAlias(Location: null)].
        using var fixture = QuestMod(withLocation: false, out var quest);

        var result = fixture.EditHandler.Edit(fixture.Plugin, quest.ToString(), MoveTo(1, Member("Aliases"), At(0)));

        Assert.True(result.Applied, result.Message);
        var body = fixture.Body(quest);
        var refIdx = body.IndexOf("QuestReferenceAlias", StringComparison.Ordinal);
        var locIdx = body.IndexOf("QuestLocationAlias", StringComparison.Ordinal);
        Assert.True(refIdx >= 0 && locIdx >= 0, body);
        Assert.True(refIdx < locIdx, $"QuestReferenceAlias should now precede QuestLocationAlias in:\n{body}");
    }

    [Fact]
    public void ArrayMoveDown_ArrayContainsElementWithSetNestedStructField_AppliesAndPreservesIt()
    {
        // Location: { AliasID: 9 }.
        using var fixture = QuestMod(withLocation: true, out var quest);

        var result = fixture.EditHandler.Edit(fixture.Plugin, quest.ToString(), MoveTo(1, Member("Aliases"), At(0)));

        Assert.True(result.Applied, result.Message);
        var body = fixture.Body(quest);
        var refIdx = body.IndexOf("QuestReferenceAlias", StringComparison.Ordinal);
        var locIdx = body.IndexOf("QuestLocationAlias", StringComparison.Ordinal);
        Assert.True(refIdx >= 0 && locIdx >= 0, body);
        Assert.True(refIdx < locIdx, $"QuestReferenceAlias should now precede QuestLocationAlias in:\n{body}");
        Assert.Contains("\"AliasID\": 9", body, StringComparison.Ordinal);
    }

    private static SourceModFixture QuestMod(bool withLocation, out FormKey quest)
    {
        var formKey = FormKey.Null;
        var fixture = SourceModFixture.Tracked("Quest630.esp", "Quest630Mod", mod =>
        {
            var record = new Quest(mod.GetNextFormKey("Quest630"), Fallout4Release.Fallout4)
            {
                EditorID = "Quest630",
                Aliases =
                [
                    new QuestLocationAlias { Name = "LocAlias" },
                    new QuestReferenceAlias
                    {
                        Name = "RefAlias",
                        Location = withLocation ? new LocationAliasReference { AliasID = 9 } : null,
                    },
                ],
            };
            mod.Quests.Add(record);
            formKey = record.FormKey;
        });
        quest = formKey;
        return fixture;
    }

    private static SourceModFixture ContainerMod(out FormKey container)
    {
        var formKey = FormKey.Null;
        var fixture = SourceModFixture.Tracked("Container630.esp", "Container630Mod", mod =>
        {
            var record = new Container(mod.GetNextFormKey("Container630"), Fallout4Release.Fallout4)
            {
                EditorID = "Container630",
            };
            mod.Containers.Add(record);
            formKey = record.FormKey;
        });
        container = formKey;
        return fixture;
    }

    private static JsonElement Stages(SourceModFixture fixture, FormKey container)
    {
        using var document = JsonDocument.Parse(fixture.Body(container));
        return document.RootElement.GetProperty("Destructible").GetProperty("Stages").Clone();
    }
}
