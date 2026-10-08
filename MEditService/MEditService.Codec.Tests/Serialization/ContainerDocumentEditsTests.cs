using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Serialization;

public sealed class ContainerDocumentEditsTests
{

    private static string Text(IMajorRecordGetter record) => RecordTextCodec.SerializeToText(record, GameRelease.Fallout4);

    private static JsonElement Read(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }

    private static string EditorIdOf(JsonElement record) =>
        record.GetProperty("EditorID").GetString() ?? throw new InvalidOperationException("Expected a record to carry its EditorID.");

    private static string[] EditorIdsIn(JsonElement owner, string slot) =>
        owner.TryGetProperty(slot, out var held) ? [.. held.EnumerateArray().Select(EditorIdOf)] : [];

    private static string? Appended(Worldspace worldspace, Cell cell) =>
        ContainerDocumentEdits.WithChildAppended(
            Text(worldspace), GameRelease.Fallout4, RecordTypes.For(GameRelease.Fallout4).RecordTypeOf(worldspace),
            worldspace.FormKey.ToString(), "TopCell", Text(cell), RecordTypes.For(GameRelease.Fallout4).RecordTypeOf(cell));

    [Fact]
    public void AppendingToAWorldspacesPersistentCell_WhenItHoldsNone_SetsIt()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Append.esp"), Fallout4Release.Fallout4);
        var worldspace = new Worldspace(mod) { EditorID = "World" };
        var cell = new Cell(mod) { EditorID = "Persistent" };

        Assert.Contains(cell.FormKey.ToString(), Appended(worldspace, cell).Require(), StringComparison.Ordinal);
    }

    [Fact]
    public void AppendingToAWorldspacesPersistentCell_WhenItHoldsOne_RefusesNamingBoth()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Append.esp"), Fallout4Release.Fallout4);
        var held = new Cell(mod) { EditorID = "Held" };
        var worldspace = new Worldspace(mod) { EditorID = "World", TopCell = held };
        var other = new Cell(mod) { EditorID = "Other" };

        var refusal = Assert.Throws<ChildSlotHeldByAnotherRecordException>(() => Appended(worldspace, other));

        Assert.Contains(held.FormKey.ToString(), refusal.Message, StringComparison.Ordinal);
        Assert.Contains(other.FormKey.ToString(), refusal.Message, StringComparison.Ordinal);
    }
}
