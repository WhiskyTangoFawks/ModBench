using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Xunit.Abstractions;

namespace MEditService.PluginAdapter.Tests.RealData;

public sealed class CodecFixedPointTests(ITestOutputHelper output)
{
    [Fact]
    public void EveryDocumentOfTheCutDownPlugin_DeserializesAndReserializesToItself()
    {
        var documents = DocumentsOfCutDownPlugin();

        Assert.True(documents.Count > 3000,
            $"Expected the whole cut-down plugin to be read; got {documents.Count} documents.");

        var divergent = documents.SelectMany(document => Divergence(document)).ToList();

        output.WriteLine($"{documents.Count} records round-tripped through the codec.");
        Assert.True(divergent.Count == 0,
            $"{divergent.Count} of {documents.Count} records are not a codec fixed point:\n"
            + string.Join("\n", divergent.Take(10)));
    }

    private static List<PluginDocument> DocumentsOfCutDownPlugin()
    {
        var modPath = new ModPath(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath);
        using var documents = TestAdapters.Mutagen()
            .OpenDocuments(modPath, GameRelease.Fallout4, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4))
            .Answered();
        var all = new List<PluginDocument> { documents.Header };
        all.AddRange(documents.Records);
        Assert.Empty(documents.Failures);
        return all;
    }

    private static IEnumerable<string> Divergence(PluginDocument document)
    {
        var where = $"{document.RecordType} {document.FormKey}";
        if (document.ParseDiagnosis is { } diagnosis)
            return [$"{where}: the codec could not read the record — {diagnosis}"];

        string reserialized;
        try
        {
            reserialized = document.RecordType == PluginHeader.RecordType
                ? RoundTripHeader(document.Text)
                : RoundTripRecord(document.RecordType, document.Text);
        }
        catch (Exception ex) when (ex is not Xunit.Sdk.XunitException)
        {
            return [$"{where}: the codec could not read its own document — {ex.Message}"];
        }

        return reserialized == document.Text ? [] : [$"{where}: {FirstDifference(document.Text, reserialized)}"];
    }

    private static string RoundTripRecord(string recordType, string stored)
    {
        return RecordTextCodec.RoundTrip(stored, GameRelease.Fallout4, recordType);
    }

    private static string RoundTripHeader(string stored) =>
        Encoding.UTF8.GetString(HeaderDocument.Write(HeaderDocument.Read(Encoding.UTF8.GetBytes(stored))));

    private static string FirstDifference(string expected, string actual)
    {
        var expectedLines = expected.Split('\n');
        var actualLines = actual.Split('\n');
        for (var i = 0; i < Math.Max(expectedLines.Length, actualLines.Length); i++)
        {
            var left = i < expectedLines.Length ? expectedLines[i] : "(no line)";
            var right = i < actualLines.Length ? actualLines[i] : "(no line)";
            if (!string.Equals(left, right, StringComparison.Ordinal))
                return $"line {i + 1}: stored '{left}' vs reserialized '{right}'";
        }
        return "no line differs";
    }
}
