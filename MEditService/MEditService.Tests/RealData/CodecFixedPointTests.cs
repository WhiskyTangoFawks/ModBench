using System.Text;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Xunit.Abstractions;

namespace MEditService.Tests.RealData;

/// <summary>Whole-document equality is only a meaningful assertion where the codec is a fixed
/// point: deserializing a stored document and serializing it again gives the same bytes, over
/// every record of the real plugin rather than a curated few.</summary>
public sealed class CodecFixedPointTests(CutDownPluginFixture fixture, ITestOutputHelper output)
    : IClassFixture<CutDownPluginFixture>
{
    [Fact]
    public async Task EveryStoredDocument_DeserializesAndReserializesToItself()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var documents = fixture.Repo.At(RecordRef.Effective)
            .GetDocuments(new PluginKey(CutDownPluginFixture.PluginFileName, "Data"))
            .Where(d => d.RecordType != HeaderIndexer.RecordType)
            .ToList();

        // The plugin's own record count, so a fixture that stopped being indexed cannot pass this
        // over an empty list.
        Assert.True(documents.Count > 3000,
            $"Expected the whole cut-down plugin to be indexed; got {documents.Count} documents.");

        var divergent = new List<string>();
        foreach (var document in documents)
        {
            var stored = Encoding.UTF8.GetBytes(document.Body!);
            var record = await codec.DeserializeFromBytesAsync(stored, GameRelease.Fallout4, document.RecordType);
            var reserialized = await codec.SerializeToBytesAsync(record, GameRelease.Fallout4);
            if (!reserialized.AsSpan().SequenceEqual(stored))
            {
                divergent.Add($"{document.RecordType} {document.FormKey} ({document.EditorId}): "
                    + FirstDifference(Encoding.UTF8.GetString(stored), Encoding.UTF8.GetString(reserialized)));
            }
        }

        output.WriteLine($"{documents.Count} records round-tripped through the codec.");
        Assert.True(divergent.Count == 0,
            $"{divergent.Count} of {documents.Count} records are not a codec fixed point:\n"
            + string.Join("\n", divergent.Take(10)));
    }

    private static string FirstDifference(string stored, string reserialized)
    {
        var limit = Math.Min(stored.Length, reserialized.Length);
        var at = 0;
        while (at < limit && stored[at] == reserialized[at]) at++;
        return $"at offset {at} stored '{Excerpt(stored, at)}' vs reserialized '{Excerpt(reserialized, at)}'";
    }

    private static string Excerpt(string text, int at) =>
        text.Substring(Math.Max(0, at - 40), Math.Min(120, text.Length - Math.Max(0, at - 40)));
}
