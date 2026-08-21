using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Serialization.Newtonsoft;

namespace MEditService.Tests.Serialization;

/// <summary>
/// #450 AC1 — <b>one document shape everywhere</b>, at the byte level. ADR-0041's #444 amendment
/// rests on the claim that the per-record codec's bytes for a record and the whole-mod folder-split
/// path's file for that same record are the same bytes: untracked ingest (per-record, from binary),
/// tracked ingest (from files) and point writes all produce and consume one shape, so nothing
/// downstream ever has to know which door a document came through. The #444 spike measured that
/// claim and found exactly two deltas, both this codec's own choices (a discriminator on every
/// document, and a self-added trailing newline); both are gone as of #450, and this is the standing
/// gate that keeps them gone. <b>Zero normalization</b> is the whole point — the spike's own probe
/// normalized both deltas away to measure them, and this is that probe with the normalization
/// removed.
///
/// <para><b>This is Tests-side deliberately.</b> The generated whole-mod mixin is what
/// <c>RecordTextCodecGeneratorSeed</c>'s AC2 guard keeps out of <c>MEditService.Core</c>; that guard
/// scans Core's own sources, so comparing against the whole-mod door from a test is exactly how the
/// two are meant to be checked against each other.</para>
///
/// <para><b>Platform caveat, named rather than assumed.</b> The equality below is verified on Linux,
/// where the kernel's own indentation newline is <c>\n</c> and the codec's <c>\r</c>-strip is a
/// no-op. On Windows the whole-mod door's <c>Environment.NewLine</c> would make its file
/// <c>\r\n</c>-delimited while the codec still emits bare <c>\n</c> — the canonical form. That
/// difference is #444's open Windows question (ADR-0041: "Windows behavior of the whole-mod door to
/// be verified at implementation, the parity gate adjudicating"); it belongs to the parity gate and
/// the whole-mod door's own configuration, not to this codec, whose canonical output is defined as
/// bare <c>\n</c> with no trailing newline on every platform.</para>
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
