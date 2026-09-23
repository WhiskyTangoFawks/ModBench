using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Group-folder names come from <see cref="RecordTypeDispatch"/> rather than literals, so
/// these tests cannot drift from whatever the reflection walk decides.</summary>
public sealed class SourceRepositoryLayoutTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;

    [Theory]
    // The routine case.
    [InlineData("Vendor.esp", "npc_", "000800:Vendor.esp", "SomeNpc")]
    // No EditorID — the bare filesafe FormKey, no leading "&lt;EditorID&gt; - ".
    [InlineData("Vendor.esp", "npc_", "000800:Vendor.esp", null)]
    // A plugin name with its own internal dot must round-trip as one whole segment (the layout
    // never splits a plugin name on its own dots) — a patch-plugin-shaped filename proves this for
    // real rather than by argument.
    [InlineData("Vendor.patch.esp", "Keyword", "0012AB:Vendor.patch.esp", "SomeKeyword")]
    // The record's origin ModKey legitimately differs from the plugin holding it (an override edited
    // through a patch plugin) — the two segments must recombine into the *origin's* FormKey, not the
    // target plugin's.
    [InlineData("Vendor.esp", "npc_", "000800:Master1.esm", "AnOverride")]
    // Non-ASCII plugin names and EditorIDs are ordinary in this modding scene — the identity
    // recovered from the path must carry the same plugin-name bytes For() started from.
    [InlineData("Café.esp", "npc_", "000800:Café.esp", "Né")]
    [InlineData("Плагин.esp", "npc_", "0012AB:Плагин.esp", "Имя")]
    public void Put_ThenGet_RoundTripsPluginAndRecordType(
        string pluginFileName, string recordType, string formKeyString, string? editorId)
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-layout-roundtrip-").FullName;
        try
        {
            SourceRepository.Track(
                modFolder, SourcePreset.Edits, [], new TrackProvenance(null, null, new Dictionary<string, string>()));
            var repository = SourceRepository.Open(modFolder, Release)
                ?? throw new InvalidOperationException($"Expected '{modFolder}' to already be tracked.");
            var plugin = new PluginCopyKey(pluginFileName, "LayoutMod");
            repository.Put(plugin, new SourceDocument(formKeyString, recordType, editorId, "{}"));

            var path = Path.GetRelativePath(
                modFolder, Directory.EnumerateFiles(modFolder, "*.json", SearchOption.AllDirectories).Single());

            // Everything nests under one root "source/" folder (the on-disk root Track and Put
            // both write to), the plugin its own child directory, not a "<plugin>.source/" sibling
            // tree.
            var segments = path.Split(Path.DirectorySeparatorChar);
            Assert.Equal("source", segments[0]);
            Assert.Equal(pluginFileName, segments[1]);

            // The identity survives the round trip: Get, asked with the exact identity Put was
            // given, finds the very file Put just placed.
            var document = repository.Get(plugin, new RecordIdentity(formKeyString, recordType, editorId));

            Assert.NotNull(document);
            Assert.Equal(formKeyString, document.FormKey);
            // Get answers RecordTypeDispatch's schema-table-name spelling; Put() accepts either. The
            // two need not match textually, only resolve to the same concrete type, which this
            // equality checks for real rather than assuming a spelling.
            var expectedConcrete = RecordTypeDispatch.For(Release).ConcreteFor(recordType);
            Assert.NotNull(expectedConcrete);
            Assert.Equal(expectedConcrete, RecordTypeDispatch.For(Release).ConcreteFor(document.RecordType));
        }
        finally
        {
            try { Directory.Delete(modFolder, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
        }
    }

    // The one bridge from the door's own tree to the mod folder holding it. The name is verbatim: a
    // ModKey renders the extension lowercase, and a tree read from another root is invisible.
    [Fact]
    public void PristineFilesOf_PutsTheDoorsTree_UnderTheRootTheNameSpells()
    {
        var pristine = SourceRepository.PristineFilesOf(
            "Mixed.ESP",
            [new TreeFile("RecordData.json", [1]),
             new TreeFile(Path.Combine("npc_", "SomeNpc - 000800_Mixed.ESP.json"), [2])]);

        Assert.Equal(
            [Path.Combine("source", "Mixed.ESP", "RecordData.json"),
             Path.Combine("source", "Mixed.ESP", "npc_", "SomeNpc - 000800_Mixed.ESP.json")],
            pristine.Select(file => file.RelativePath));
        Assert.Equal([1], pristine[0].Content);
    }

    [Fact]
    public void PathCarrying_AFlatRecord_IsTheFileWhoseNameCarriesTheFormKey()
    {
        string[] paths =
        [
            "source/Vendor.esp/npc_/Other - 000900_Vendor.esp.json",
            "source/Vendor.esp/npc_/SomeNpc - 000800_Vendor.esp.json",
        ];

        Assert.Equal(
            "source/Vendor.esp/npc_/SomeNpc - 000800_Vendor.esp.json",
            SourceRepository.PathCarrying(paths, "Vendor.esp", "000800:Vendor.esp"));
    }

    // A container's document is named for the door, not for the record, so the FormKey is on the
    // directory holding it.
    [Fact]
    public void PathCarrying_AContainer_IsTheDocumentOfTheDirectoryWhoseNameCarriesTheFormKey()
    {
        string[] paths = ["source/Vendor.esp/Cells/0, 0/0, 0/SomeCell - 0012AB_Vendor.esp/RecordData.json"];

        Assert.Equal(paths[0], SourceRepository.PathCarrying(paths, "Vendor.esp", "0012AB:Vendor.esp"));
    }

    // The plugin header's document is the one the layout names after no FormKey at all: it is the
    // plugin's own, and PluginHeader decides which FormKey that is.
    [Fact]
    public void PathCarrying_ThePluginsOwnHeader_IsTheTreesRootDocument()
    {
        string[] paths = ["source/Vendor.esp/RecordData.json"];

        Assert.Equal(
            paths[0],
            SourceRepository.PathCarrying(
                paths, "Vendor.esp", PluginHeader.FormKeyFor(ModKey.FromFileName("Vendor.esp"))));
    }

    // The rival that reads every door-named document as the record of the directory above it would
    // answer the plugin's own folder here.
    [Fact]
    public void PathCarrying_ARecordThatIsNotTheHeader_DoesNotMatchTheTreesRootDocument()
    {
        string[] paths = ["source/Vendor.esp/RecordData.json"];

        Assert.Null(SourceRepository.PathCarrying(paths, "Vendor.esp", "000800:Vendor.esp"));
    }

    // A git listing spells its separators one way and a Windows working tree the other, so the door
    // answers both and no caller normalizes before asking.
    [Fact]
    public void PathCarrying_AWindowsSeparatedContainer_IsAnsweredLikeAGitListing()
    {
        string[] paths = [@"C:\mods\VendorMod\source\Vendor.esp\Cells\0, 0\0, 0\SomeCell - 0012AB_Vendor.esp\RecordData.json"];

        Assert.Equal(paths[0], SourceRepository.PathCarrying(paths, "Vendor.esp", "0012AB:Vendor.esp"));
    }

    // The same, for the header's fixed path: its own separators must not decide whether it is found.
    [Fact]
    public void PathCarrying_AWindowsSeparatedHeaderDocument_IsThePluginsOwnHeader()
    {
        string[] paths = [@"C:\mods\VendorMod\source\Vendor.esp\RecordData.json"];

        Assert.Equal(
            paths[0],
            SourceRepository.PathCarrying(
                paths, "Vendor.esp", PluginHeader.FormKeyFor(ModKey.FromFileName("Vendor.esp"))));
    }

    [Fact]
    public void PathCarrying_NothingHoldingTheFormKey_IsNull()
    {
        Assert.Null(SourceRepository.PathCarrying(
            ["source/Vendor.esp/npc_/Other - 000900_Vendor.esp.json"], "Vendor.esp", "000800:Vendor.esp"));
    }

    // A listing is read from git and from a directory walk, and neither is promised to be free of an
    // empty line: the door answers for one rather than throwing past its caller.
    [Fact]
    public void PathCarrying_APathWithNoSegments_IsPassedOver()
    {
        string[] paths = ["", "/", "source/Vendor.esp/npc_/SomeNpc - 000800_Vendor.esp.json"];

        Assert.Equal(paths[2], SourceRepository.PathCarrying(paths, "Vendor.esp", "000800:Vendor.esp"));
        Assert.Null(SourceRepository.PathCarrying(["", "/"], "Vendor.esp", "000800:Vendor.esp"));
    }
}
