using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class EditRecordChangesTests : IDisposable
{
    private const int Persistent = 0x0400;
    private const int PartialForm = 0x4000;
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
    public void AFieldEdit_OfARecordWhoseFileWasRemovedAfterItWasRead_IsRefusedAsRecordNotFound_AndAnswersNoChanges(string record)
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
        var document = answer.Changes.Documents.Single(change => change.Text.Contains("000F00:Fixture.esp", StringComparison.Ordinal));
        Assert.Contains("TypedButUnsaved", document.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void AFormIdEdit_ToAKeyAChildInTheGivenTextHolds_IsRefusedAsACollision()
    {
        var cell = new Cell(_mod.Cell, Fallout4Release.Fallout4) { EditorID = "FixtureCell" };
        cell.Temporary.Add(new PlacedObject(new FormKey(_mod.Cell.ModKey, 0xF00), Fallout4Release.Fallout4));
        var unsaved = RecordTextCodec.SerializeToText(cell, GameRelease.Fallout4);

        var answer = _mod.EditChangesHandler.Changes(_mod.Plugin, _mod.Cell.ToString(), Set("FormKey", $"\"000F00:{_mod.Cell.ModKey}\""), unsaved);

        Assert.Equal(RecordEditRefusal.FormKeyCollision, answer.Outcome.Refusal);
    }

    [Theory]
    [InlineData("FormKey", "\"000F00:Fixture.esp\"")]
    [InlineData("HeightMin", "0.75")]
    public void AnEdit_GivenTextTheCodecCannotRead_IsRefusedAsRecordParseFailed_AndAnswersNoChanges(string member, string value)
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

    [Fact]
    public void AChildRecordsEdit_ChangesOnlyItsOwnTextInTheTextItIsGiven()
    {
        using var world = WorldWithACellAtTheOriginHoldingAMoverAndAWandererNineCellsAway(out var keys);
        var given = TextOf(world, world.Plugin, keys["Mover"].ToString())
            .Replace("\"EditorID\": \"Wanderer\"", "\"EditorID\":\"Wanderer\"", StringComparison.Ordinal);

        var answer = world.EditChangesHandler.Changes(world.Plugin, keys["Mover"].ToString(), Set("EditorID", "\"Renamed\""), given);

        Assert.True(answer.Outcome.Applied, answer.Outcome.Message);
        Assert.Equal(
            given.Replace("\"EditorID\": \"Mover\"", "\"EditorID\": \"Renamed\"", StringComparison.Ordinal),
            Assert.Single(answer.Changes.Documents).Text);
    }

    [Fact]
    public void AChildRecordsEdit_BesideASiblingTheCodecCannotRead_IsMade_AndKeepsTheSiblingAsGiven()
    {
        using var world = WorldWithACellAtTheOriginHoldingAMoverAndAWandererNineCellsAway(out var keys);
        var given = TextOf(world, world.Plugin, keys["Mover"].ToString())
            .Replace("\"EditorID\": \"Wanderer\"", "\"EditorID\": \"Wanderer\", \"Scale\": { \"x\": 1 }", StringComparison.Ordinal);

        var answer = world.EditChangesHandler.Changes(world.Plugin, keys["Mover"].ToString(), Set("EditorID", "\"Renamed\""), given);

        Assert.True(answer.Outcome.Applied, answer.Outcome.Message);
        Assert.Equal(
            given.Replace("\"EditorID\": \"Mover\"", "\"EditorID\": \"Renamed\"", StringComparison.Ordinal),
            Assert.Single(answer.Changes.Documents).Text);
    }

    [Fact]
    public void AChildRecordsFormIdEdit_ChangesOnlyItsOwnTextInTheTextItIsGiven_BesideAHandFormattedSiblingTheCodecCannotRead()
    {
        using var world = WorldWithACellAtTheOriginHoldingAMoverAndAWandererNineCellsAway(out var keys);
        var leaving = Path.Combine(world.ModFolder, TrackedTree.DocumentFile(world.ModFolder, world.Plugin, keys["Mover"].ToString()).Require());
        var given = TextOf(world, world.Plugin, keys["Mover"].ToString())
            .Replace("\"EditorID\": \"Wanderer\"", "\"EditorID\":\"Wanderer\", \"Scale\": { \"x\": 1 }", StringComparison.Ordinal);

        var answer = world.EditChangesHandler.Changes(world.Plugin, keys["Mover"].ToString(), Set("FormKey", "\"000F00:World.esp\""), given);

        Assert.True(answer.Outcome.Applied, answer.Outcome.Message);
        Assert.Equal(
            given.Replace($"\"FormKey\": \"{keys["Mover"]}\"", "\"FormKey\": \"000F00:World.esp\"", StringComparison.Ordinal),
            Assert.Single(answer.Changes.Documents, document => document.Path == leaving).Text);
    }

    [Fact]
    public void APlacedRecordCrossingIntoAnotherCell_LeavesTheRestOfTheTextItIsGivenAsItWas()
    {
        using var world = WorldWithACellAtTheOriginHoldingAMoverAndAWandererNineCellsAway(out var keys);
        var leaving = Path.Combine(world.ModFolder, TrackedTree.DocumentFile(world.ModFolder, world.Plugin, keys["Mover"].ToString()).Require());
        var given = TextOf(world, world.Plugin, keys["Mover"].ToString())
            .Replace("\"EditorID\": \"Here\"", "\"EditorID\":\"Here\"", StringComparison.Ordinal);

        var answer = world.EditChangesHandler.Changes(world.Plugin, keys["Wanderer"].ToString(), Flags(0), given);

        Assert.True(answer.Outcome.Applied, answer.Outcome.Message);
        var left = Assert.Single(answer.Changes.Documents, document => document.Path == leaving).Text;
        Assert.Contains("\"EditorID\":\"Here\"", left, StringComparison.Ordinal);
        Assert.DoesNotContain("Wanderer", left, StringComparison.Ordinal);
    }

    [Fact]
    public void APlacedRecordLandingInThePersistentCell_LeavesTheRestOfItsWorldspacesDocumentAsItWas()
    {
        using var world = WorldWithACellAtTheOriginHoldingAMoverAndAWandererNineCellsAway(out var keys, withAPersistentCell: true);
        var worldspace = Path.Combine(world.ModFolder, TrackedTree.DocumentFile(world.ModFolder, world.Plugin, keys["World"].ToString()).Require());
        File.WriteAllText(
            worldspace, File.ReadAllText(worldspace).Replace("\"EditorID\": \"World\"", "\"EditorID\":\"World\"", StringComparison.Ordinal));

        var answer = Changes(world, world.Plugin, keys["Mover"].ToString(), Flags(Persistent));

        Assert.True(answer.Outcome.Applied, answer.Outcome.Message);
        var landed = Assert.Single(answer.Changes.Documents, document => document.Path == worldspace).Text;
        Assert.Contains("\"EditorID\":\"World\"", landed, StringComparison.Ordinal);
        Assert.Contains("\"Mover\"", landed, StringComparison.Ordinal);
    }

    [Fact]
    public void ThePlacedRecordsGroup_IsTheOneTheTextItIsGivenHoldsItIn()
    {
        using var world = WorldWithACellAtTheOriginHoldingAMoverAndAWandererNineCellsAway(out var keys);
        var cell = JsonNode.Parse(TextOf(world, world.Plugin, keys["Mover"].ToString())).Require().AsObject();
        var mover = cell["Temporary"].Require().AsArray()[0].Require().DeepClone();
        cell.Remove("Temporary");
        mover["MajorRecordFlagsRaw"] = Persistent;
        cell["Persistent"].Require().AsArray().Add(mover);

        var answer = world.EditChangesHandler.Changes(world.Plugin, keys["Mover"].ToString(), Flags(0), cell.ToJsonString());

        Assert.True(answer.Outcome.Applied, answer.Outcome.Message);
        var written = JsonNode.Parse(Assert.Single(answer.Changes.Documents).Text).Require();
        Assert.Equal(["Mover"], EditorIdsIn(written, "Temporary"));
        Assert.Equal(["Wanderer"], EditorIdsIn(written, "Persistent"));
    }

    private static List<string> EditorIdsIn(JsonNode cell, string group) =>
        [.. cell[group].Require().AsArray().Select(placed => placed.Require()["EditorID"].Require().GetValue<string>())];

    [Fact]
    public void APersistentCellsPartialForm_IsJudgedByThePluginDefiningIt_NeverByWhereItSits()
    {
        using var world = WorldWithACellAtTheOriginHoldingAMoverAndAWandererNineCellsAway(out var keys, withAPersistentCell: true);

        var answer = Changes(world, world.Plugin, keys["PersistentCell"].ToString(), Flags(PartialForm));

        Assert.Equal(RecordEditRefusal.CannotBePartialForm, answer.Outcome.Refusal);
        Assert.Contains("xEdit makes a cell a Partial Form only where Fallout4.esm defines it", answer.Outcome.Message, StringComparison.Ordinal);
    }

    private static SourceModFixture WorldWithACellAtTheOriginHoldingAMoverAndAWandererNineCellsAway(
        out Dictionary<string, FormKey> keys, bool withAPersistentCell = false)
    {
        var held = new Dictionary<string, FormKey>();
        var fixture = SourceModFixture.Tracked("World.esp", "WorldMod", mod =>
        {
            var world = new Worldspace(mod) { EditorID = "World" };
            held["World"] = world.FormKey;
            if (withAPersistentCell)
            {
                world.TopCell = new Cell(mod) { EditorID = "PersistentCell" };
                held["PersistentCell"] = world.TopCell.FormKey;
            }
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
