using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginRefusalTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public async Task Compile_WithTwoDocumentsClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        TreeTampering.Duplicate(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(_mod.Npc.ToString(), refused.Message);
    }

    [Fact]
    public async Task Compile_WithADocumentItCannotRead_RefusesNamingTheFile()
    {
        var file = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        using var held = TreeTampering.HoldOpen(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, file), refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WithADocumentInAnotherTypesFolder_RefusesNamingTheFile_WithoutExceptionText()
    {
        var file = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        var misfiled = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(file)) ?? "", "Globals", Path.GetFileName(file));
        _ = Directory.CreateDirectory(Path.GetDirectoryName(misfiled) ?? "");
        File.Move(file, misfiled);

        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Equal(CompileRefusal.SourceDoesNotParse, refused.Refusal);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, misfiled), refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Object reference", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WithTwoBrokenFiles_RefusesNamingBothAndTheFieldAtFaultInEach()
    {
        var otherIdentity = new RecordIdentity(_mod.OtherNpc.ToString(), CompileFixture.NpcRecordType, CompileFixture.OtherNpcEditorId);
        var npcFile = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        var otherFile = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, otherIdentity);
        _mod.Overwrite(_mod.NpcIdentity, _mod.Document(_mod.Npc.ToString()).Require().Body.Replace("\"Race\"", "\"RaceOld\"", StringComparison.Ordinal));
        _mod.Overwrite(otherIdentity, _mod.Document(_mod.OtherNpc.ToString()).Require().Body.Replace("\"EditorID\"", "\"EditorTypo\"", StringComparison.Ordinal));

        var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Equal(CompileRefusal.SourceDoesNotParse, refused.Refusal);
        Assert.Contains($"{Path.GetRelativePath(_mod.ModFolder, npcFile)}: RaceOld", refused.Message, StringComparison.Ordinal);
        Assert.Contains($"{Path.GetRelativePath(_mod.ModFolder, otherFile)}: EditorTypo", refused.Message, StringComparison.Ordinal);
        Assert.EndsWith("Decompile the plugin to regenerate the source.", refused.Message, StringComparison.Ordinal);
        Assert.Empty(answer.Applied);
    }

    [Fact]
    public async Task Compile_WithAContainerDirectoryHoldingTwoDocumentsNoneNamedForIt_RefusesNamingTheDirectoryAndDecompile()
    {
        using var mod = SourceModFixture.CompiledPlugin("Cells.esp", "CellsMod", plugin =>
        {
            var cell = new Cell(plugin) { EditorID = "FixtureCell" };
            cell.Temporary.Add(new PlacedObject(plugin) { EditorID = "FixtureRef" });
            plugin.AddInteriorCells(cell);
        });
        var cell = SourceModTree.DocumentCarrying(mod.ModFolder, mod.Plugin, "FixtureRef");
        var document = TreeTampering.FileOf(mod.ModFolder, mod.Plugin, new RecordIdentity(cell.FormKey, cell.RecordType, cell.EditorId));
        var directory = Path.GetDirectoryName(document).Require();
        File.Copy(document, Path.Combine(directory, "Copy.json"));
        File.Move(document, Path.Combine(directory, "Other.json"));

        var answer = (await mod.CompileHandler.CompileAsync([mod.Plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Equal(CompileRefusal.SourceDoesNotParse, refused.Refusal);
        Assert.Contains(Path.GetRelativePath(mod.ModFolder, directory), refused.Message, StringComparison.Ordinal);
        Assert.EndsWith("Decompile the plugin to regenerate the source.", refused.Message, StringComparison.Ordinal);
    }

    [PosixFact]
    public async Task Compile_WithAFolderOfItsSourceItCannotList_RefusesWithoutPointingAtDecompile()
    {
        var folder = Path.GetDirectoryName(TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity)).Require();
        FileModes.Set(folder, "000");
        try
        {
            var answer = (await _mod.CompileHandler.CompileAsync([_mod.Plugin])).Value();

            var refused = Assert.Single(answer.Refused);
            Assert.Equal(CompileRefusal.SourceDoesNotParse, refused.Refusal);
            Assert.DoesNotContain("Decompile", refused.Message, StringComparison.Ordinal);
        }
        finally
        {
            FileModes.Set(folder, "700");
        }
    }
}
