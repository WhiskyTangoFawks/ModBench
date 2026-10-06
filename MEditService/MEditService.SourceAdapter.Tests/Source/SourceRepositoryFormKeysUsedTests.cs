using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryFormKeysUsedTests : IDisposable
{
    private const string PluginName = "FormKeysUsed.esp";
    private static readonly PluginAddress Plugin = new(PluginName, "HoldsMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly ScratchDirectory _modFolder = new("medit-holds-");
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);

    public void Dispose() => _modFolder.Dispose();

    private string Git(params string[] args) =>
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private SourceRepository Tracked(params TreeFile[] files)
    {
        if (files.Length == 0) PluginBaselines.TrackWithNoRecords(_modFolder);
        else PluginBaselines.Track(_modFolder, files);
        return SourceRepository.Open(TestMod.In(_modFolder), Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    [Fact]
    public void AnUncommittedHeaderDocument_IsHeld_ThoughNoRefButTheWorkingTreeCarriesIt()
    {
        var headerPath = PluginSourceRoot.HeaderDocument(PluginName);
        var repository = Tracked(new TreeFile(headerPath, "{\"MasterReferences\": []}"u8.ToArray()));
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));

        var headerPathInGitsForwardSlashes = headerPath.Replace('\\', '/');
        Git("rm", "--cached", "-q", "--", headerPathInGitsForwardSlashes);
        Git("commit", "-q", "-m", "leave the header at no ref, as a plugin minted since the last commit has it");

        Assert.Empty(Git("ls-tree", "-r", "--name-only", "HEAD", "--", headerPathInGitsForwardSlashes));
        Assert.True(repository.FormKeysUsed(Plugin).Contains(headerFormKey));
    }

    [Theory]
    [InlineData("Npcs/RenamedByHand.json")]
    [InlineData("Npcs/Misnamed - 000900_FormKeysUsed.esp.json")]
    public void AnUncommittedDocumentNamedForNoKeyItDeclares_IsHeld(string relativePath)
    {
        var repository = Tracked();
        var file = Path.Combine(_modFolder, PluginSourceRoot.For(PluginName), relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(file).Require());
        File.WriteAllText(file, $"{{\"FormKey\": \"000850:{PluginName}\", \"EditorID\": \"Hidden\"}}");

        Assert.True(repository.FormKeysUsed(Plugin).Contains($"000850:{PluginName}"));
    }

    [Fact]
    public void AnUncommittedEmbeddedChild_IsHeld_UnderAnyFormKeySpellingThatParses()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var child = new PlacedObject(mod) { EditorID = "TopCellRef", Position = new P3Float(7f, 8f, 9f), Scale = 6f };
        var topCell = new Cell(mod) { EditorID = "TopCell", WaterHeight = 5f };
        topCell.Temporary.Add(child);
        var worldspace = new Worldspace(mod) { EditorID = "World", TopCell = topCell };
        var worldspacePath = Path.Combine(
            PluginSourceRoot.For(PluginName), "Worldspaces",
            $"{worldspace.EditorID} - {worldspace.FormKey.ID:X6}_{worldspace.FormKey.ModKey.FileName}", "RecordData.json");

        var repository = Tracked(
            new TreeFile(worldspacePath, _codec.SerializeToBytes(worldspace, Release)));

        var movedInTheWorkingTreeAlone = $"00080A:{PluginName}";
        var file = Path.Combine(_modFolder, worldspacePath);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(child.FormKey.ToString(), movedInTheWorkingTreeAlone, StringComparison.Ordinal));

        Assert.True(repository.FormKeysUsed(Plugin).Contains(movedInTheWorkingTreeAlone));
        Assert.True(repository.FormKeysUsed(Plugin).Contains($"00080a:{PluginName}"));
        Assert.False(repository.FormKeysUsed(Plugin).Contains($"00099F:{PluginName}"));
    }
}
