using System.Text.Json;
using MEditService.Core.Serialization;
using MEditService.Tests.RealData;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>
/// #450 S4 (ADR-0041's #444 amendment), inverting #413 D8: a container record's document holds its
/// <b>embedded children</b>, because that is what the whole-mod folder-split path — Spriggit's own
/// output — puts in that record's file. The deep-copy-and-strip step D8 introduced is gone with the
/// posture that needed it: the parent's file is the child's source unit now, and the index's
/// container_child/placement rows are extracted <i>from</i> the parent rather than replacing it.
///
/// The scope of "embedded" is Spriggit's, not ours: <c>Cell.{Persistent,Temporary,Landscape,
/// NavigationMeshes}</c> and <c>Worldspace.TopCell</c> only. A quest's dialog topics stay
/// folder-split on both doors, so a quest's document still carries none of them — which is why the
/// second test below is a quest and reads as "no change" rather than as an oversight.
///
/// The subject is found by measurement rather than pinned by FormKey: the curated plugin is
/// regenerable, so a hardcoded FormKey would silently decay into testing nothing. Every assertion
/// below is paired with the positive control that such a record actually exists in the corpus.
/// </summary>
public sealed class ContainerDocumentTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    private readonly CutDownPluginFixture _fixture = fixture;

    private static readonly string[] CellChildFields = ["Persistent", "Temporary", "NavigationMeshes", "Landscape"];

    private string? StoredBody(string formKey)
    {
        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT body FROM records WHERE form_key = $1";
        cmd.Parameters.Add(new DuckDB.NET.Data.DuckDBParameter { Value = formKey });
        return cmd.ExecuteScalar() as string;
    }

    /// <summary>
    /// The case that used to make the strip load-bearing, now read the other way round: a cell whose
    /// codec bytes carry child records must have exactly those bytes stored against it. Anything that
    /// re-introduced a strip — at ingest, or by reviving the child-stream suppression for the
    /// embedded slots — puts the index back out of step with the source file and fails here.
    /// </summary>
    [Fact]
    public async Task Index_ForACellWithChildren_StoresThemEmbeddedInTheCellsOwnDocument()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);

        var withInlinedChildren = new List<(ICellGetter Cell, string[] Fields)>();
        foreach (var cell in overlay.EnumerateMajorRecords<ICellGetter>(throwIfUnknown: false))
        {
            using var doc = JsonDocument.Parse(await codec.SerializeToBytesAsync(cell, GameRelease.Fallout4));
            var present = CellChildFields.Where(f => doc.RootElement.TryGetProperty(f, out _)).ToArray();
            if (present.Length > 0) withInlinedChildren.Add((cell, present));
        }

        Assert.True(withInlinedChildren.Count > 0,
            "Positive control: at least one cell in the corpus must carry embedded children when " +
            "serialized, or this test proves nothing about storing them.");

        var missing = new List<string>();
        foreach (var (cell, expected) in withInlinedChildren)
        {
            var body = StoredBody(cell.FormKey.ToString());
            Assert.NotNull(body);
            using var stored = JsonDocument.Parse(body);
            foreach (var field in expected)
            {
                if (!stored.RootElement.TryGetProperty(field, out _))
                    missing.Add($"{cell.FormKey}.{field}");
            }
        }

        Assert.Empty(missing);
    }

    /// <summary>
    /// The invariant the whole document shape rests on: what the index stores for a record is
    /// byte-for-byte what its source file holds. Asserted on a quest — the container Spriggit does
    /// not embed — so it also pins that dropping the strip did not quietly start inlining the
    /// folder-split children too.
    /// </summary>
    [Fact]
    public async Task Index_ForAContainer_StoresTheSameBytesTheSourcePathWould()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var setterMod = ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);

        var quest = setterMod.EnumerateMajorRecords<IQuest>().First(q => q.DialogTopics.Count > 0);
        var formKey = quest.FormKey.ToString();

        // Exactly what TrackService does to write a source file — which since #450 is nothing but
        // the codec call itself.
        var sourceBytes = await codec.SerializeToBytesAsync(quest, GameRelease.Fallout4);

        var body = StoredBody(formKey);

        Assert.NotNull(body);
        Assert.Equal(System.Text.Encoding.UTF8.GetString(sourceBytes), body);
    }

    /// <summary>
    /// And the same for the ~95% that were never containers, which #413 D8's deep copy already
    /// skipped: the stored body is the codec's own bytes, with nothing interposed.
    /// </summary>
    [Fact]
    public async Task Index_ForANonContainer_StoresTheCodecsBytesUnchanged()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);

        var weapon = ((IFallout4ModGetter)overlay).Weapons.First();
        var expected = await codec.SerializeToBytesAsync(weapon, GameRelease.Fallout4);

        Assert.Equal(System.Text.Encoding.UTF8.GetString(expected), StoredBody(weapon.FormKey.ToString()));
    }
}
