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
/// #413 S4 / D8: a container record's document holds only the container's own fields.
///
/// A Cell/Worldspace/Quest/DialogTopic serialized straight off the binary overlay ingest holds can
/// still inline its children — suppressing the serializer's per-child streams and folders stops the
/// filesystem writes, not the parent's own stream (that distinction is measured and recorded on
/// <c>RecordTextCodec.DiscardChildRecordStreams</c>). Children are their own records, their own
/// documents and their own source entries (ADR-0040/#387); a parent that carried them would store
/// the same data twice and give the parent a body that no source file will ever match.
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
    /// The case that makes the strip load-bearing: a cell whose raw overlay serialization really
    /// does carry child records. Its stored document must not.
    /// </summary>
    [Fact]
    public async Task Index_ForACellWhoseOverlayInlinesChildren_StoresOnlyTheCellsOwnFields()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);

        var withInlinedChildren = new List<ICellGetter>();
        foreach (var cell in overlay.EnumerateMajorRecords<ICellGetter>(throwIfUnknown: false))
        {
            using var doc = JsonDocument.Parse(await codec.SerializeToBytesAsync(cell, GameRelease.Fallout4));
            if (CellChildFields.Any(f => doc.RootElement.TryGetProperty(f, out _)))
                withInlinedChildren.Add(cell);
        }

        Assert.True(withInlinedChildren.Count > 0,
            "Positive control: at least one cell in the corpus must inline children when serialized " +
            "raw, or this test proves nothing about stripping them.");

        var offenders = new List<string>();
        foreach (var cell in withInlinedChildren)
        {
            var body = StoredBody(cell.FormKey.ToString());
            Assert.NotNull(body);
            using var stored = JsonDocument.Parse(body);
            foreach (var field in CellChildFields)
            {
                if (stored.RootElement.TryGetProperty(field, out _))
                    offenders.Add($"{cell.FormKey}.{field}");
            }
        }

        Assert.Empty(offenders);
    }

    /// <summary>
    /// Stripping must not become "store less of everything". The container's own fields survive
    /// intact — asserted against the same codec output the source path produces, so this pins
    /// equality with the source's bytes rather than merely the absence of children.
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

        // Exactly what TrackService does before writing a source file.
        MEditService.Core.Source.ContainerStripFields.StripInPlace(quest);
        var sourceBytes = await codec.SerializeToBytesAsync(quest, GameRelease.Fallout4);

        var body = StoredBody(formKey);

        Assert.NotNull(body);
        Assert.Equal(System.Text.Encoding.UTF8.GetString(sourceBytes), body);
    }

    /// <summary>
    /// The strip is scoped to containers. A non-container record must be stored exactly as the codec
    /// renders it — the deep copy the container path needs is ~5% of a real corpus, and quietly
    /// applying it (or anything else) to the other 95% would be a cost with no cause.
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
