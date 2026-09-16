using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Tests.RealData;

/// <summary>Order damage measured against the tree Track actually wrote, deserialized the way
/// <see cref="MEditService.Commands.Edits.PluginCompileService"/> does, against the original binary's
/// own GRUP order. Expected 0 and 0 (ADR-0006 decision 4).</summary>
public sealed class DialogueOrderDamageTests : IDisposable
{
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-order-damage-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-order-damage-game-").FullName;
    private readonly IndexProjector _index;
    private readonly PluginCopyKey _plugin = new(CutDownPluginFixture.PluginFileName, "FixtureMod");

    public DialogueOrderDamageTests()
    {
        var holder = new LoadOrderHolder();
        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        _index = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        _index.Reconcile(holder,
            _gameDirectory,
            [new LoadOrderEntry(CutDownPluginFixture.PluginFileName, pluginPath, _plugin.Origin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
            .TrackAsync(_index, holder, _plugin.Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _index.Dispose();
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
    // The damage-measurement harness: Measure compares two independently-obtained child orderings
    // for the same set of parents.
    // ---------------------------------------------------------------------------------------------

    private readonly record struct ParentOrdering(string ParentLabel, IReadOnlyList<FormKey> Children);

    private readonly record struct OrderDamage(int MultiChildParents, int PermutedParents, int MovedSlots);

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

        var sourceTree = Path.Combine(_modFolder, SourceRepository.RootFor(CutDownPluginFixture.PluginFileName));
        var written = await RecordTextCodecGeneratorSeed
            .DeserializeWholeMod(sourceTree, InlineWorkDropoff.Instance, CancellationToken.None);
        var actual = DialogueOrderings((IFallout4ModGetter)written);

        var damage = Measure(expected, actual);

        // Under an unprefixed filename scheme this exact fixture measures 96 permuted parents and
        // 1,540 moved slots (of 283 multi-response DIALs) — this is the same measurement, on the
        // tree Track actually wrote, with EnforceRecordOrder on.
        Assert.Equal(283, damage.MultiChildParents);
        Assert.Equal(0, damage.PermutedParents);
        Assert.Equal(0, damage.MovedSlots);
    }
}
