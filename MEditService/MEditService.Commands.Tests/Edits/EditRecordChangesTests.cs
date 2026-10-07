using System.Globalization;
using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class EditRecordChangesTests : IDisposable
{
    private const int Persistent = 0x0400;
    private const float CellWidth = 4096f;

    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static RecordEditEnvelope Set(string member, string value) => SetAt(Json(value), Member(member));

    private static RecordEditEnvelope Flags(int raw) =>
        SetAt(Json(raw.ToString(CultureInfo.InvariantCulture)), Member("MajorRecordFlagsRaw"));

    private static string TextOf(TestInstance instance, PluginAddress plugin, string formKey) =>
        File.ReadAllText(Path.Combine(instance.ModFolderOf(plugin), TrackedTree.DocumentFile(instance.ModFolderOf(plugin), plugin, formKey).Require()));

    private static RecordEditChanges Changes(TestInstance instance, PluginAddress plugin, string formKey, RecordEditEnvelope envelope) =>
        instance.EditChangesHandler.Changes(plugin, formKey, envelope, TextOf(instance, plugin, formKey));

    [Fact]
    public void AFieldEdit_AnswersTheRecordsDocumentWithTheNewValue_AndWritesNothing()
    {
        var before = TreeSnapshot.Of(_mod.ModFolder);

        var answer = Changes(_mod, _mod.Plugin, _mod.Npc.ToString(), Set("HeightMax", "0.75"));

        Assert.True(answer.Outcome.Applied, answer.Outcome.Message);
        Assert.Empty(answer.Changes.Moves);
        var document = Assert.Single(answer.Changes.Documents);
        Assert.Equal(Path.Combine(_mod.ModFolder, _mod.DocumentFile(_mod.Npc.ToString()).Require()), document.Path);
        Assert.Contains("0.75", document.Text, StringComparison.Ordinal);
        Assert.Equal(before, TreeSnapshot.Of(_mod.ModFolder));
    }

    [Fact]
    public void AFieldEdit_BuildsOnTheTextItIsGiven_NotOnTheFile()
    {
        var unsaved = TextOf(_mod, _mod.Plugin, _mod.Npc.ToString())
            .Replace($"\"{SourceEditFixture.NpcEditorId}\"", "\"TypedButUnsaved\"", StringComparison.Ordinal);
        Assert.Contains("TypedButUnsaved", unsaved, StringComparison.Ordinal);

        var answer = _mod.EditChangesHandler.Changes(_mod.Plugin, _mod.Npc.ToString(), Set("HeightMax", "0.75"), unsaved);

        var document = Assert.Single(answer.Changes.Documents);
        Assert.Contains("TypedButUnsaved", document.Text, StringComparison.Ordinal);
        Assert.Contains("0.75", document.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void AFieldEdit_OfARecordWhoseFileIsNoDocument_BuildsOnTheTextItIsGiven()
    {
        var given = TextOf(_mod, _mod.Plugin, _mod.Npc.ToString());
        var file = Path.Combine(_mod.ModFolder, _mod.DocumentFile(_mod.Npc.ToString()).Require());
        File.WriteAllText(file, "not a document");

        var answer = _mod.EditChangesHandler.Changes(_mod.Plugin, _mod.Npc.ToString(), Set("HeightMax", "0.75"), given);

        Assert.True(answer.Outcome.Applied, answer.Outcome.Message);
        var document = Assert.Single(answer.Changes.Documents);
        Assert.Equal(file, document.Path);
        Assert.Contains("0.75", document.Text, StringComparison.Ordinal);
        Assert.Equal("not a document", File.ReadAllText(file));
    }

    [Theory]
    [InlineData("npc")]
    [InlineData("quest")]
    [InlineData("cell")]
    public void AFieldEdit_OfARecordWhoseFileWasRemovedAfterItWasRead_IsRefused_AndChangesNothing(string record)
    {
        var formKey = (record switch { "npc" => _mod.Npc, "quest" => _mod.Quest, _ => _mod.Cell }).ToString();
        var given = TextOf(_mod, _mod.Plugin, formKey);
        File.Delete(Path.Combine(_mod.ModFolder, _mod.DocumentFile(formKey).Require()));

        var answer = _mod.EditChangesHandler.Changes(_mod.Plugin, formKey, Set("EditorID", "\"Edited\""), given);

        Assert.Equal(RecordEditRefusal.RecordNotFound, answer.Outcome.Refusal);
        Assert.Empty(answer.Changes.Documents);
    }

    [Fact]
    public void AFormIdEdit_BuildsOnTheTextItIsGiven_NotOnTheFile()
    {
        var unsaved = TextOf(_mod, _mod.Plugin, _mod.Npc.ToString())
            .Replace($"\"{SourceEditFixture.NpcEditorId}\"", "\"TypedButUnsaved\"", StringComparison.Ordinal);

        var answer = _mod.EditChangesHandler.Changes(_mod.Plugin, _mod.Npc.ToString(), Set("FormKey", "\"000F00:Fixture.esp\""), unsaved);

        Assert.True(answer.Outcome.Applied, answer.Outcome.Message);
        var document = Assert.Single(answer.Changes.Documents);
        Assert.Contains("TypedButUnsaved", document.Text, StringComparison.Ordinal);
        Assert.Contains("000F00:Fixture.esp", document.Text, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("FormKey", "\"000F00:Fixture.esp\"")]
    [InlineData("HeightMin", "0.75")]
    public void AnEdit_GivenTextTheCodecCannotRead_IsRefusedAsUnreadable_AndChangesNothing(string member, string value)
    {
        var unreadable = TextOf(_mod, _mod.Plugin, _mod.Npc.ToString())
            .Replace($"\"{SourceEditFixture.NpcEditorId}\"", $"\"{SourceEditFixture.NpcEditorId}\", \"HeightMax\": {{ \"x\": 1 }}", StringComparison.Ordinal);

        var answer = _mod.EditChangesHandler.Changes(_mod.Plugin, _mod.Npc.ToString(), Set(member, value), unreadable);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, answer.Outcome.Refusal);
        Assert.Empty(answer.Changes.Moves);
        Assert.Empty(answer.Changes.Documents);
    }

    [Fact]
    public void APlacedRecordCrossingIntoAnotherCell_BuildsOnTheTextItIsGivenForTheCellItLeaves()
    {
        using var world = WorldWithACellAtTheOriginHoldingAMoverAndAWandererNineCellsAway(out var keys);
        var leaving = Path.Combine(world.ModFolder, TrackedTree.DocumentFile(world.ModFolder, world.Plugin, keys["Mover"].ToString()).Require());
        var unsaved = TextOf(world, world.Plugin, keys["Mover"].ToString())
            .Replace("\"Wanderer\"", "\"TypedButUnsaved\"", StringComparison.Ordinal);
        Assert.Contains("TypedButUnsaved", unsaved, StringComparison.Ordinal);

        var answer = world.EditChangesHandler.Changes(world.Plugin, keys["Mover"].ToString(), Flags(Persistent), unsaved);

        Assert.True(answer.Outcome.Applied, answer.Outcome.Message);
        var left = Assert.Single(answer.Changes.Documents, document => document.Path == leaving);
        Assert.Contains("TypedButUnsaved", left.Text, StringComparison.Ordinal);
        Assert.DoesNotContain("Mover", left.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void AnEditThatChangesNothing_AnswersNoChanges()
    {
        var unchanged = Changes(_mod, _mod.Plugin, _mod.Npc.ToString(), Set("EditorID", $"\"{SourceEditFixture.NpcEditorId}\""));

        Assert.True(unchanged.Outcome.Applied, unchanged.Outcome.Message);
        Assert.Empty(unchanged.Changes.Moves);
        Assert.Empty(unchanged.Changes.Documents);
    }

    [Fact]
    public void ARefusedEdit_AnswersItsRefusal_AndNoChanges()
    {
        var answer = Changes(_mod, _mod.Plugin, _mod.Npc.ToString(), Set("NoSuchField", "1"));

        Assert.Equal(RecordEditRefusal.FieldNotFound, answer.Outcome.Refusal);
        Assert.Empty(answer.Changes.Documents);
    }

    [Fact]
    public void AnEditorIdEdit_AnswersTheMoveOfTheRecordsFileToItsNewName()
    {
        var answer = Changes(_mod, _mod.Plugin, _mod.Npc.ToString(), Set("EditorID", "\"RenamedNpc\""));

        var move = Assert.Single(answer.Changes.Moves);
        Assert.Equal(Path.Combine(_mod.ModFolder, _mod.DocumentFile(_mod.Npc.ToString()).Require()), move.From);
        Assert.Contains("RenamedNpc", move.To, StringComparison.Ordinal);
        Assert.Equal(move.To, Assert.Single(answer.Changes.Documents).Path);
    }

    [Fact]
    public void APlacedRecordCrossingIntoAGridCellThePluginLacks_IsAnsweredInADocumentOfThatCellApart_FromTheCellItLeft()
    {
        using var world = WorldWithACellAtTheOriginHoldingAMoverAndAWandererNineCellsAway(out var keys);

        var answer = Changes(world, world.Plugin, keys["Wanderer"].ToString(), Flags(0));

        Assert.True(answer.Outcome.Applied, answer.Outcome.Message);
        var arrived = Assert.Single(answer.Changes.Documents, document => document.Text.Contains("\"Wanderer\"", StringComparison.Ordinal));
        Assert.DoesNotContain("\"Mover\"", arrived.Text, StringComparison.Ordinal);
    }

    private static SourceModFixture WorldWithACellAtTheOriginHoldingAMoverAndAWandererNineCellsAway(out Dictionary<string, FormKey> keys)
    {
        var held = new Dictionary<string, FormKey>();
        var fixture = SourceModFixture.Tracked("World.esp", "WorldMod", mod =>
        {
            var world = new Worldspace(mod) { EditorID = "World" };
            var here = new Cell(mod) { EditorID = "Here", Grid = new CellGrid { Point = new P2Int(0, 0) } };
            here.Temporary.Add(Placed(mod, held, "Mover", 0, 0.5f));
            here.Persistent.Add(Placed(mod, held, "Wanderer", Persistent, 9.5f));
            var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
            subBlock.Items.Add(here);
            var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
            block.Items.Add(subBlock);
            world.SubCells.Add(block);
            mod.Worldspaces.Add(world);
        });
        keys = held;
        return fixture;
    }

    private static PlacedObject Placed(Fallout4Mod mod, Dictionary<string, FormKey> keys, string editorId, int flags, float cells)
    {
        var placed = new PlacedObject(mod)
        {
            EditorID = editorId,
            MajorRecordFlagsRaw = flags,
            Position = new P3Float(cells * CellWidth, cells * CellWidth, 0f),
        };
        keys[editorId] = placed.FormKey;
        return placed;
    }
}
