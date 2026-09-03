using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Serialization.Newtonsoft;

namespace MEditService.Tests.Serialization;

/// <summary>
/// <b>One document shape everywhere</b>, at the byte level. ADR-0041
/// rests on the claim that the per-record codec's bytes for a record and the whole-mod folder-split
/// path's file for that same record are the same bytes: untracked ingest (per-record, from binary),
/// tracked ingest (from files) and point writes all produce and consume one shape, so nothing
/// downstream ever has to know which door a document came through. Measurement found
/// exactly two possible deltas, both this codec's own choices (a discriminator on every
/// document, and a self-added trailing newline); both are gone, and this is the standing
/// gate that keeps them gone. <b>Zero normalization</b> is the whole point.
///
/// <para><b>This is Tests-side deliberately.</b> The generated whole-mod mixin is what
/// <c>RecordTextCodecGeneratorSeed</c>'s whole-mod guard keeps out of <c>MEditService.Core</c>; that guard
/// scans Core's own sources, so comparing against the whole-mod door from a test is exactly how the
/// two are meant to be checked against each other.</para>
///
/// <para><b>Platform caveat, named rather than assumed.</b> The equality below is verified on Linux,
/// where the kernel's own indentation newline is <c>\n</c> and the codec's <c>\r</c>-strip is a
/// no-op. On Windows the whole-mod door's <c>Environment.NewLine</c> would make its file
/// <c>\r\n</c>-delimited while the codec still emits bare <c>\n</c> — the canonical form. That
/// difference is the open Windows question (ADR-0041: "Windows behavior of the whole-mod door to
/// be verified at implementation"), currently unaddressed by any automated check; it
/// belongs to the whole-mod door's own configuration, not to this codec, whose canonical output is
/// defined as bare <c>\n</c> with no trailing newline on every platform.</para>
/// </summary>
public sealed class DocumentShapeParityTests
{
    private static RecordTextCodec Codec() => new(NullLogger<RecordTextCodec>.Instance);

    private static Fallout4Mod NewMod() => new(ModKey.FromFileName("Parity.esp"), Fallout4Release.Fallout4);

    /// <summary>
    /// A populated interior cell — the embedded case, and the one the spike pinned. Under Spriggit's
    /// embed customization the cell's whole content is a single <c>RecordData.json</c> inside its own
    /// directory, so "the whole-mod path's file for this cell" is unambiguous.
    /// </summary>
    [Fact]
    public async Task PerRecordCodecBytes_ForAnEmbeddedCell_EqualTheWholeModPathsFileForIt()
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "ParityCell" };
        cell.Persistent.Add(new PlacedObject(mod) { EditorID = "Parity_Persistent" });
        cell.Temporary.Add(new PlacedObject(mod) { EditorID = "Parity_Temporary" });
        cell.NavigationMeshes.Add(new NavigationMesh(mod) { EditorID = "Parity_Navmesh" });
        cell.Landscape = new Landscape(mod) { EditorID = "Parity_Landscape" };

        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);

        await AssertBothDoorsAgree(mod, cell, "ParityCell");
    }

    /// <summary>
    /// A populated quest — the container Spriggit does <b>not</b> embed. Its dialog topics and their
    /// responses stay folder-split on both doors, which is why <see cref="RecordTextCodec"/> keeps
    /// its child-stream and child-folder suppressions instead of retiring them with the shallow-strip
    /// machinery. Byte parity here is what makes "keeping them costs nothing at the byte level" a
    /// checked fact rather than a claim in a comment.
    /// </summary>
    [Fact]
    public async Task PerRecordCodecBytes_ForANonEmbeddedContainer_EqualTheWholeModPathsFileForIt()
    {
        var mod = NewMod();
        var quest = MakePopulatedQuest(mod);
        mod.Quests.Add(quest);

        await AssertBothDoorsAgree(mod, quest, "ParityQuest");
    }

    /// <summary>
    /// The other half of the same guard, which byte parity cannot see: the whole-mod door writes a
    /// quest's dialog topics into real child directories, and the per-record codec must not — it
    /// serializes one record to one caller-given file, and its callers hand it no directory to spill
    /// into. Measured before those suppressions existed: one real quest created 1,057 directories in
    /// the process's working directory, one per dialogue topic, and a load-order-wide index would do
    /// that for every container it read.
    /// </summary>
    [Fact]
    public async Task SerializeAsync_ForANonEmbeddedContainer_WritesExactlyOneFileAndNoChildFolders()
    {
        var dir = Directory.CreateTempSubdirectory("medit-parity-quest-files-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "quest.json");
            await Codec().SerializeAsync(MakePopulatedQuest(NewMod()), filePath, GameRelease.Fallout4);

            Assert.Equal([filePath], Directory.GetFiles(dir.FullName, "*", SearchOption.AllDirectories));
            Assert.Empty(Directory.GetDirectories(dir.FullName, "*", SearchOption.AllDirectories));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    private static Quest MakePopulatedQuest(Fallout4Mod mod)
    {
        var quest = new Quest(mod) { EditorID = "ParityQuest", Name = "Parity Quest" };
        var topic = new DialogTopic(mod) { EditorID = "ParityTopic" };
        topic.Responses.Add(new DialogResponses(mod) { EditorID = "ParityResponse" });
        quest.DialogTopics.Add(topic);
        return quest;
    }

    /// <summary>
    /// Two more "nothing is omitted" clauses, on record shapes the committed real fixture cannot exercise:
    /// its <c>ModHeader.OverriddenForms</c> is genuinely null (the fixture's header is built fresh by
    /// <c>CutDownPluginGenerator</c>, never copied from the real Fallout4.esm header it slices), and
    /// every <c>Fallout4Group</c>/<c>Worldspace</c> in it is likewise constructed fresh with only
    /// <c>BlockNumber</c>/<c>EditorID</c> copied — so <c>LastModified</c>/<c>SubCellsTimestamp</c> stay
    /// at their CLR default (0) there regardless of whether anything omits them. Neither gap is caused
    /// by any Omit customization; both need a hand-built mod instead, the same reason
    /// <see cref="RecordTextCodecTests.MakeWeapon"/> exists for the per-record codec's own fixtures.
    /// This uses the whole-mod door directly (as <see cref="AssertBothDoorsAgree"/> above already does)
    /// because none of <c>ModHeader</c>, <c>Fallout4ListGroup&lt;T&gt;</c>, or a group's own
    /// <c>LastModified</c> is reachable through <see cref="RecordTextCodec"/>, which only ever takes a
    /// single <see cref="Mutagen.Bethesda.Plugins.Records.IMajorRecordGetter"/>.
    ///
    /// <para><b><c>OverriddenForms</c>:</b> nothing in <c>Serialization/</c> or <c>Source/</c> may
    /// suppress it — a per-type Omit customization would leave the root document with no
    /// <c>"OverriddenForms"</c> key at all.</para>
    ///
    /// <para><b><c>LastModified</c>/<c>SubCellsTimestamp</c>:</b>
    /// with <c>.OmitLastModifiedData()</c> in <see cref="Serialization.RecordTextCodecCustomization"/>,
    /// this test fails with "Assert.Contains() Failure: Sub-string not found" against a
    /// <c>Cells/0/GroupRecordData.json</c> that is empty (<c>{}</c>).</para>
    /// </summary>
    [Fact]
    public async Task Serialize_OfASyntheticModWithNonDefaultGroupAndHeaderFields_WritesThemUnomitted()
    {
        var mod = NewMod();
        var overriddenForm = new FormKey(ModKey.FromFileName("Test.esm"), 0x001);
        mod.ModHeader.SetOverriddenForms([overriddenForm]);

        var cell = new Cell(mod) { EditorID = "TimestampCell" };
        var subBlock = new CellSubBlock { BlockNumber = 0, LastModified = 424242 };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, LastModified = 424242 };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
        mod.Cells.LastModified = 424242;

        var worldspace = mod.Worldspaces.AddNew();
        worldspace.EditorID = "TimestampWorldspace";
        worldspace.SubCellsTimestamp = 424242;

        var dir = Directory.CreateTempSubdirectory("medit-parity-synthetic-");
        try
        {
            await MutagenJsonConverter.Instance.Serialize(mod, dir.FullName);

            var rootText = await File.ReadAllTextAsync(Path.Combine(dir.FullName, "RecordData.json"));
            Assert.Contains($"\"OverriddenForms\"", rootText, StringComparison.Ordinal);
            Assert.Contains(overriddenForm.ToString(), rootText, StringComparison.Ordinal);

            var cellGroupFile = Path.Combine(dir.FullName, "Cells", "0", "GroupRecordData.json");
            Assert.True(File.Exists(cellGroupFile), $"Expected {cellGroupFile} to exist.");
            Assert.Contains("\"LastModified\": 424242", await File.ReadAllTextAsync(cellGroupFile), StringComparison.Ordinal);

            var worldspaceFile = Directory.EnumerateFiles(dir.FullName, "RecordData.json", SearchOption.AllDirectories)
                .Single(f => f.Contains("TimestampWorldspace", StringComparison.Ordinal));
            Assert.Contains("\"SubCellsTimestamp\": 424242", await File.ReadAllTextAsync(worldspaceFile), StringComparison.Ordinal);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    private static async Task AssertBothDoorsAgree(
        Fallout4Mod mod, Mutagen.Bethesda.Plugins.Records.IMajorRecordGetter record, string editorId)
    {
        var dir = Directory.CreateTempSubdirectory("medit-parity-");
        try
        {
            await MutagenJsonConverter.Instance.Serialize(mod, dir.FullName);

            var recordDir = Assert.Single(
                Directory.EnumerateDirectories(dir.FullName, $"*{editorId}*", SearchOption.AllDirectories));
            var wholeModFile = Path.Combine(recordDir, "RecordData.json");
            Assert.True(File.Exists(wholeModFile), $"Expected the whole-mod door to write {wholeModFile}.");

            var wholeModBytes = await File.ReadAllBytesAsync(wholeModFile);
            var codecBytes = await Codec().SerializeToBytesAsync(record, GameRelease.Fallout4);

            Assert.Equal(
                System.Text.Encoding.UTF8.GetString(wholeModBytes),
                System.Text.Encoding.UTF8.GetString(codecBytes));
            Assert.Equal(wholeModBytes, codecBytes);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
