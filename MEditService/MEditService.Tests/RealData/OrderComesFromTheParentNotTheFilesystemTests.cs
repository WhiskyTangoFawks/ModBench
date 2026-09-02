using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;
using Noggog.WorkEngine;

namespace MEditService.Tests.RealData;

/// <summary>
/// The parent's ordered child list is what decides order — not the order the filesystem happens to
/// hand its children back in.
///
/// <para><b>Why this needs its own test, and why it reverses a list rather than shuffling files.</b>
/// The phase-1 spike named this the real hazard of #566: with identity-only file names, every
/// reader's enumeration order is undefined, so a folder-split site whose order carrier was never
/// written still <i>looks</i> correct whenever enumeration happens to agree with the recorded order —
/// and it will agree, often, because Track writes files in the very order it later reads them back.
/// A test that only checks "the tree round-trips" therefore passes by luck.</para>
///
/// <para>Shuffling the files themselves cannot fix that: enumeration order is the filesystem's to
/// choose and no test can portably force it. So this inverts the experiment — hold the files still
/// and <b>reverse the recorded order</b>. If the reader honours the list, the mod comes back
/// reversed; if it is really just enumerating a directory, it comes back unchanged. That
/// distinguishes the two outright, on every folder-split site the fixture has, and it fails for a
/// site whose carrier is missing exactly as it fails for one that is ignored.</para>
/// </summary>
public sealed class OrderComesFromTheParentNotTheFilesystemTests(CompileRoundTripGateFixture fixture)
    : IClassFixture<CompileRoundTripGateFixture>
{
    [Fact]
    public async Task ReversingATopicsRecordedOrder_ReversesTheResponsesItReadsBack()
    {
        // Its own copy of the already-tracked template: this test rewrites a document in place, and
        // the shared fixture tree is read-only to everyone else.
        var modFolder = Directory.CreateTempSubdirectory("medit-order-carrier-").FullName;
        CompileRoundTripGateFixture.CopyDirectory(fixture.TrackedTemplateFolder, modFolder);
        var sourceRoot = Path.Combine(modFolder, SourceRecordPath.RootFor(CutDownPluginFixture.PluginFileName));

        // A topic with enough responses that a reversal cannot coincide with the original.
        var topicDirectory = Directory
            .EnumerateDirectories(sourceRoot, "Responses", SearchOption.AllDirectories)
            .Select(Path.GetDirectoryName)
            .Select(directory => directory!)
            .First(directory => SourceChildOrder
                .ListAt(SourceChildOrder.CarrierFor(directory, parentIsRecord: true), "Responses").Count >= 3);

        var carrier = SourceChildOrder.CarrierFor(topicDirectory, parentIsRecord: true);
        var recorded = SourceChildOrder.ListAt(carrier, "Responses");

        var before = await ReadResponses(sourceRoot, topicDirectory);
        Assert.Equal(recorded, before);

        // Reverse the list in the parent's document. Not one file is touched, renamed or moved.
        var namesBefore = Directory.GetFiles(Path.Combine(topicDirectory, "Responses")).Order(StringComparer.Ordinal).ToList();
        RewriteOrder(carrier, "Responses", recorded.Reverse().ToList());

        var after = await ReadResponses(sourceRoot, topicDirectory);

        Assert.Equal(recorded.Reverse().ToList(), after);
        Assert.NotEqual(before, after);
        Assert.Equal(
            namesBefore,
            Directory.GetFiles(Path.Combine(topicDirectory, "Responses")).Order(StringComparer.Ordinal).ToList());

        CompileRoundTripGateFixture.TryDelete(modFolder);
    }

    /// <summary>The FormKeys of one topic's responses, as the whole-mod read door yields them.</summary>
    private static async Task<List<string>> ReadResponses(string sourceRoot, string topicDirectory)
    {
        var mod = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(
            sourceRoot, InlineWorkDropoff.Instance, CancellationToken.None);

        var topicLeaf = Path.GetFileName(topicDirectory);
        var topic = ((IFallout4ModGetter)mod).Quests
            .SelectMany(quest => quest.DialogTopics)
            .Single(candidate => topicLeaf.EndsWith(
                $"{candidate.FormKey.ID:X6}_{candidate.FormKey.ModKey.FileName}", StringComparison.Ordinal));

        return [.. topic.Responses.Select(response => response.FormKey.ToString())];
    }

    /// <summary>Replaces one ordered child list in place, leaving the rest of the document alone —
    /// the hand edit an external tool or a merge could make.</summary>
    private static void RewriteOrder(string carrierPath, string key, IReadOnlyList<string> order)
    {
        var document = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(carrierPath))!.AsObject();
        var list = new System.Text.Json.Nodes.JsonArray();
        foreach (var identity in order) list.Add(identity);
        document[SourceChildOrder.MemberName]!.AsObject()[key] = list;

        File.WriteAllText(
            carrierPath, document.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    }
}
