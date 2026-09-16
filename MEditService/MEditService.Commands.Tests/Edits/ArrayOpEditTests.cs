using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.Edits;

/// <summary>An array op is computed server-side from the record's current value, never
/// round-tripped as a client-computed whole array; the envelope is <c>value</c> itself, told apart
/// by shape.</summary>
public sealed class ArrayOpEditTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private EditRecordHandler Service() => _mod.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string NpcBody() => _mod.Document(_mod.Npc.ToString()).Require().Body;

    private string SecondKeyword()
    {
        var result = _mod.CreateHandler.CreateRecord(_mod.Plugin, "kywd", "SecondKeyword");
        Assert.True(result.Applied, result.Message);
        return result.NewFormKey.Require();
    }

    [Fact]
    public void ArrayRemove_TopLevelArray_RemovesTheNamedElementAndKeepsTheOthers()
    {
        var second = SecondKeyword();
        var seed = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), RemoveAt(Member("Keywords"), At(0)));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        Assert.DoesNotContain(_mod.Keyword.ToString(), body, StringComparison.Ordinal);
        Assert.Contains(second, body, StringComparison.Ordinal);
    }

    // An element that is not there is a path the document does not know, so a stale panel never
    // hears that a write which did nothing landed. A real git status is the honest nothing-written check.
    [Fact]
    public void ArrayRemove_IndexPastTheEnd_IsRefusedNamingTheLength_AndCommitsNothing()
    {
        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), RemoveAt(Member("Keywords"), At(0)));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal("Keywords[0]", result.Path);
        Assert.Contains("holds 0 element", result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.GitStatus());
    }

    // The non-empty array names a rival the empty case cannot rule out: an implementation that
    // clamps an out-of-range index to the nearest valid one and removes that element instead.
    [Fact]
    public void ArrayRemove_IndexPastTheEndOfANonEmptyArray_IsRefusedAndKeepsEveryElement()
    {
        var second = SecondKeyword();
        var seed = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), RemoveAt(Member("Keywords"), At(5)));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Contains("holds 2 element", result.Message, StringComparison.Ordinal);
        var body = NpcBody();
        Assert.Contains(_mod.Keyword.ToString(), body, StringComparison.Ordinal);
        Assert.Contains(second, body, StringComparison.Ordinal);
    }

    // ── array_move_up / array_move_down ────────────────────────────────────────

    [Fact]
    public void ArrayMoveDown_TopLevelArray_SwapsWithTheNextElement()
    {
        var second = SecondKeyword();
        var seed = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), MoveTo(1, Member("Keywords"), At(0)));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        var secondIdx = body.IndexOf(second, StringComparison.Ordinal);
        var firstIdx = body.IndexOf(_mod.Keyword.ToString(), StringComparison.Ordinal);
        Assert.True(secondIdx >= 0 && firstIdx >= 0, body);
        Assert.True(secondIdx < firstIdx, $"'{second}' should now precede '{_mod.Keyword}' in:\n{body}");
    }

    [Fact]
    public void ArrayMoveUp_TopLevelArray_SwapsWithThePreviousElement()
    {
        var second = SecondKeyword();
        var seed = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), MoveTo(0, Member("Keywords"), At(1)));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        var secondIdx = body.IndexOf(second, StringComparison.Ordinal);
        var firstIdx = body.IndexOf(_mod.Keyword.ToString(), StringComparison.Ordinal);
        Assert.True(secondIdx >= 0 && firstIdx >= 0, body);
        Assert.True(secondIdx < firstIdx, $"'{second}' should now precede '{_mod.Keyword}' in:\n{body}");
    }

    // A destination outside the array is a position the document does not have, refused like any
    // other unknown path rather than reported as a move that landed.
    [Theory]
    [InlineData(0, -1)]
    [InlineData(1, 2)]
    public void ArrayMove_ToAPositionOutsideTheArray_IsRefusedAndCommitsNothing(int from, int destination)
    {
        var second = SecondKeyword();
        var seed = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);
        var before = NpcBody();

        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), MoveTo(destination, Member("Keywords"), At(from)));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal($"Keywords[{destination}]", result.Path);
        Assert.Contains("holds 2 element", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    // ── array_add ────────────────────────────────────────────────────────────

    // A struct-element array, not keywords: BuildListElement returns null for an unresolvable bare
    // FormLink element, so that shape is silently dropped rather than refused.
    [Fact]
    public void ArrayAdd_StructElementArray_AppendsADefaultElement()
    {
        using var fixture = ContainerMod(out var container);
        var seed = fixture.EditHandler.Set(fixture.Plugin, container.ToString(), "Destructible",
            Json("""{"Stages": [{"HealthPercent": 50}]}"""));
        Assert.True(seed.Applied, seed.Message);

        var result = fixture.EditHandler.Edit(fixture.Plugin, container.ToString(), AddAt(Member("Destructible"), Member("Stages")));

        Assert.True(result.Applied, result.Message);
        var stages = Stages(fixture, container);
        // stages[1]'s HealthPercent is at its CLR default and Mutagen's serializer omits any field equal
        // to its default, so the new element's key is genuinely absent rather than present-and-zero.
        Assert.Equal(2, stages.GetArrayLength());
        Assert.Equal(50, stages[0].GetProperty("HealthPercent").GetByte());
    }

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
