using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Tests.RealData;

/// <summary>
/// #459 acceptance criterion: "#464's harness numbers for 'order damage' become 0 permuted parents
/// when measured on the written tree instead of the sorted-filename proxy." The harness itself
/// (<c>OrderingMeasurements.Measure</c>, <c>ParentOrdering</c>, <c>Child</c>) is spike #464's own —
/// read in full from the throwaway <c>spike-464-cross-game-ordering</c> branch (never merged;
/// <c>Spike464CrossGameOrderingProbeTests.cs</c> there) — but that spike measured damage against a
/// <b>proxy</b>: children re-sorted by the Spriggit filename they'd get under the old, unprefixed
/// scheme, compared to GRUP order, on a tree nothing ever actually wrote. This measures the same
/// shape of damage against the tree Track <i>actually wrote</i>, post-#459: deserialize the mod from
/// the tracked source tree exactly the way <see cref="Edits.PluginCompileService"/> does, and compare
/// each DialogTopic's <c>Responses</c> order there against the original binary's own GRUP order.
///
/// <para>Baseline this replaces (measured on this exact fixture, #464's own numbers): 96 of 283
/// multi-response DIALs permuted, 1,540 INFO slots moved, under the old unprefixed scheme. Expected
/// here, with <c>Overall.EnforceRecordOrder</c> on: 0 and 0 — the prefix carries the real position,
/// so writing the tree and reading it back is lossless for order, not merely stable.</para>
/// </summary>
public sealed class DialogueOrderDamageTests : IDisposable
{
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-order-damage-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-order-damage-game-").FullName;
    private readonly LoadOrderMirror _mirror;
    private readonly PluginKey _plugin = new(CutDownPluginFixture.PluginFileName, "FixtureMod");

    public DialogueOrderDamageTests()
    {
        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        _mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)_mirror).Reconcile(
            _gameDirectory,
            [new LoadOrderEntry(CutDownPluginFixture.PluginFileName, pluginPath, _plugin.Origin!, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_mirror.LoadOrder!, _plugin.Origin!, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _mirror.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }

    // ---------------------------------------------------------------------------------------------
    // The harness, ported from spike #464's own probe (types/shape identical; the only change is
    // that Measure below compares two independently-obtained orderings rather than deriving one of
    // them from a filename-sort proxy).
    // ---------------------------------------------------------------------------------------------

    private readonly record struct ParentOrdering(string ParentLabel, IReadOnlyList<FormKey> Children);

    private readonly record struct OrderDamage(int MultiChildParents, int PermutedParents, int MovedSlots);

    /// <summary>#464's damage metric, generalized to compare two already-obtained child orderings for
    /// the same set of parents (keyed by <see cref="ParentOrdering.ParentLabel"/>) instead of deriving
    /// one of them from the Spriggit-filename sort proxy the spike used when there was no written tree
    /// to measure yet.</summary>
    private static OrderDamage Measure(
        IReadOnlyDictionary<string, ParentOrdering> expected, IReadOnlyDictionary<string, ParentOrdering> actual)
    {
        int multi = 0, permuted = 0, movedSlots = 0;
        foreach (var (label, expectedParent) in expected)
        {
            if (expectedParent.Children.Count < 2) continue;
            multi++;

            Assert.True(actual.TryGetValue(label, out var actualParent), $"{label} missing from the written tree");
            Assert.Equal(expectedParent.Children.Count, actualParent.Children.Count);

            var moved = 0;
            for (var i = 0; i < expectedParent.Children.Count; i++)
            {
                if (!expectedParent.Children[i].Equals(actualParent.Children[i])) moved++;
            }

            if (moved > 0) permuted++;
            movedSlots += moved;
        }

        return new OrderDamage(multi, permuted, movedSlots);
    }

    private static Dictionary<string, ParentOrdering> DialogueOrderings(IFallout4ModGetter mod) =>
        mod.Quests
            .SelectMany(quest => quest.DialogTopics)
            .ToDictionary(
                topic => topic.FormKey.ToString(),
                topic => new ParentOrdering(
                    topic.FormKey.ToString(), topic.Responses.Select(r => r.FormKey).ToList()));

    [Fact]
    public async Task WrittenTree_ReproducesTheOriginalBinarysDialogueOrder_NoPermutedParents()
    {
        using var original = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);
        var expected = DialogueOrderings((IFallout4ModGetter)original);

        var sourceTree = Path.Combine(_modFolder, SourceRecordPath.RootFor(CutDownPluginFixture.PluginFileName));
        var written = await RecordTextCodecGeneratorSeed
            .DeserializeWholeMod(sourceTree, InlineWorkDropoff.Instance, CancellationToken.None);
        var actual = DialogueOrderings((IFallout4ModGetter)written);

        var damage = Measure(expected, actual);

        // #464's own pinned numbers on this exact fixture, under the pre-#459 unprefixed scheme, were
        // 96 permuted parents and 1,540 moved slots (of 283 multi-response DIALs) — this is the same
        // measurement, on the tree Track actually wrote, now that EnforceRecordOrder is on.
        Assert.Equal(283, damage.MultiChildParents);
        Assert.Equal(0, damage.PermutedParents);
        Assert.Equal(0, damage.MovedSlots);
    }
}
