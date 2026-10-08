using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Serialization;

public sealed class ContainerDocumentEditsTests
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static string Text(IMajorRecordGetter record) => Codec.SerializeToText(record, GameRelease.Fallout4);

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
            Codec, Text(worldspace), GameRelease.Fallout4, RecordTableName.Of(worldspace.GetType(), Schemas),
            worldspace.FormKey.ToString(), "TopCell", Text(cell), RecordTableName.Of(cell.GetType(), Schemas));

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
