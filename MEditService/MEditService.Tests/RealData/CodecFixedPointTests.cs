using System.Text;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Xunit.Abstractions;

namespace MEditService.Tests.RealData;

/// <summary>Whole-document equality means nothing unless the codec is a fixed point: deserializing
/// a stored document and serializing it again gives the same bytes, over every record of the real
/// plugin rather than a curated few.</summary>
public sealed class CodecFixedPointTests(CutDownPluginFixture fixture, ITestOutputHelper output)
    : IClassFixture<CutDownPluginFixture>
{
    [Fact]
    public async Task EveryStoredDocument_DeserializesAndReserializesToItself()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var documents = fixture.Repo.At(RecordRef.Effective)
            .GetDocuments(new PluginKey(CutDownPluginFixture.PluginFileName, "Data"));

        // The plugin's own record count, so a fixture that stopped being indexed cannot pass this
        // over an empty list.
        Assert.True(documents.Count > 3000,
            $"Expected the whole cut-down plugin to be indexed; got {documents.Count} documents.");

        var divergent = new List<string>();
        foreach (var document in documents)
        {
            var stored = Assert.IsType<string>(document.Body);
            divergent.AddRange(await Divergence(codec, document, stored));
        }

        output.WriteLine($"{documents.Count} records round-tripped through the codec.");
        Assert.True(divergent.Count == 0,
            $"{divergent.Count} of {documents.Count} records are not a codec fixed point:\n"
            + string.Join("\n", divergent.Take(10)));
    }

    private static async Task<IEnumerable<string>> Divergence(
        RecordTextCodec codec, RecordDocument document, string stored)
    {
        var where = $"{document.RecordType} {document.FormKey} ({document.EditorId})";
        string reserialized;
        try
        {
            reserialized = document.RecordType == PluginHeader.RecordType
                ? await RoundTripHeader(stored)
                : await RoundTripRecord(codec, document.RecordType, stored);
        }
        catch (Exception ex) when (ex is not Xunit.Sdk.XunitException)
        {
            return [$"{where}: the codec could not read its own document — {ex.Message}"];
        }

        return reserialized == stored ? [] : [$"{where}: {Golden.FirstDifference(stored, reserialized)}"];
    }

    private static async Task<string> RoundTripRecord(RecordTextCodec codec, string recordType, string stored)
    {
        var record = await codec.DeserializeFromBytesAsync(
            Encoding.UTF8.GetBytes(stored), GameRelease.Fallout4, recordType);
        return Encoding.UTF8.GetString(await codec.SerializeToBytesAsync(record, GameRelease.Fallout4));
    }

    // A ModHeader is not an IMajorRecordGetter, so the per-record codec has no path to it; the
    // whole-mod door is the codec that owns the header, and the fixed point is the same claim.
    private static Task<string> RoundTripHeader(string stored) =>
        Task.FromResult(Encoding.UTF8.GetString(
            HeaderDocument.Write(HeaderDocument.Read(Encoding.UTF8.GetBytes(stored)))));
}
