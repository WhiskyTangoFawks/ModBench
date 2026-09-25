using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>"Does this plugin's tree hold that FormKey at either ref" — the collision check every
/// allocation runs. Its working-tree arm answers the same questions the identity read does: the
/// header, and any spelling that parses.</summary>
public sealed class SourceRepositoryHoldsAtEitherRefTests : IDisposable
{
    private const string PluginName = "HoldsAtEitherRef.esp";
    private static readonly PluginCopyKey Plugin = new(PluginName, "HoldsMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-holds-").FullName;
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
    }

    private string Git(params string[] args) =>
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private SourceRepository Tracked(params TreeFile[] files)
    {
        PluginBaselines.Track(
            _modFolder, SourcePreset.Edits, files);
        return SourceRepository.Open(_modFolder, Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    [Fact]
    public void AnUncommittedHeaderDocument_IsHeld_ThoughNoRefButTheWorkingTreeCarriesIt()
    {
        var headerPath = SourceRepository.HeaderDocumentFor(PluginName);
        var repository = Tracked(new TreeFile(headerPath, "{\"MasterReferences\": []}"u8.ToArray()));
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));

        // The shape a plugin minted since the last commit has: its header document is on disk and at
        // no ref at all. git always speaks forward slashes, on every platform.
        Git("rm", "--cached", "-q", "--", headerPath.Replace('\\', '/'));
        Git("commit", "-q", "-m", "uncommit the header");

        Assert.DoesNotContain(repository.ReadAll(Plugin, "HEAD"), d => d.FormKey == headerFormKey);
        Assert.True(repository.HoldsAtEitherRef(Plugin, headerFormKey));
    }

    [Theory]
    [InlineData("Npcs/RenamedByHand.json")]
    [InlineData("Npcs/Misnamed - 000900_HoldsAtEitherRef.esp.json")]
    public void AnUncommittedDocumentNamedForNoKeyItDeclares_IsHeld(string relativePath)
    {
        var repository = Tracked();
        var file = Path.Combine(_modFolder, SourceRepository.RootFor(PluginName), relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(file).Require());
        File.WriteAllText(file, $"{{\"FormKey\": \"000850:{PluginName}\", \"EditorID\": \"Hidden\"}}");

        Assert.True(repository.HoldsAtEitherRef(Plugin, $"000850:{PluginName}"));
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
            SourceRepository.RootFor(PluginName), "Worldspaces",
            $"{worldspace.EditorID} - {worldspace.FormKey.ID:X6}_{worldspace.FormKey.ModKey.FileName}", "RecordData.json");

        var repository = Tracked(
            new TreeFile(worldspacePath, _codec.SerializeToBytes(worldspace, Release)));

        // Its FormID changed in the working tree alone: at HEAD the child still sits under its old key, so
        // only the working tree can answer, and only through the document that inlines it.
        var moved = $"00080A:{PluginName}";
        var file = Path.Combine(_modFolder, worldspacePath);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(child.FormKey.ToString(), moved, StringComparison.Ordinal));

        Assert.True(repository.HoldsAtEitherRef(Plugin, moved));
        Assert.True(repository.HoldsAtEitherRef(Plugin, $"00080a:{PluginName}"));
        Assert.False(repository.HoldsAtEitherRef(Plugin, $"00099F:{PluginName}"));
    }
}
