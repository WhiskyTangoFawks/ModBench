using MEditService.Codec.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

/// <summary>Unlike the leaf-coverage sweep, this needs no shape filter or depth cap: it does not
/// re-derive classification, it asks the reflector what it failed to classify, so there is no
/// tautology to avoid.</summary>
public class SchemaReflectorTotalClassificationTests
{
    private static List<LogEntry> BuildAndCollect()
    {
        var entries = new List<LogEntry>();
        // A private reflector: the shared one is built once with a null logger and caches, so it has
        // no anomalies left to report. Debug minimum, since the default floor drops those lines.
        using var factory = LoggerFactory.Create(b => b
            .SetMinimumLevel(LogLevel.Debug)
            .AddProvider(new CollectingLoggerProvider(entries)));
        new SchemaReflector(factory.CreateLogger<SchemaReflector>()).GetSchemas(GameRelease.Fallout4);
        return entries;
    }

    // Mirrors SchemaRefusals.UnclassifiedAnomalyPrefix, an internal: the prefix is a log message
    // shape, not a type this test can reach without a grant.
    private const string UnclassifiedAnomalyPrefix = "SchemaReflector: unclassified";

    private static List<string> Anomalies() =>
        BuildAndCollect()
            .Where(e => e.Message.StartsWith(UnclassifiedAnomalyPrefix, StringComparison.Ordinal))
            .Select(e => e.Message)
            .Distinct()
            .Order(StringComparer.Ordinal)
            .ToList();

    [Fact]
    public void EveryPropertyTheWalkReaches_IsClassifiedOrExplicitlyExcluded()
    {
        var anomalies = Anomalies();

        Assert.True(anomalies.Count == 0,
            $"SchemaReflector reached {anomalies.Count} propert{(anomalies.Count == 1 ? "Y" : "ies")} it " +
            "could not place in any structural class. Each is a field the editor can neither see nor " +
            "write — a real defect, not a benign gap. Either give the shape a class, or add it to " +
            "SchemaReflector's exclusion table with a named reason.\n  " +
            string.Join("\n  ", anomalies));
    }

    [Fact]
    public void GenderedItemFields_AreTheTwentyThisTicketDefers()
    {
        var gendered = BuildAndCollect()
            .Where(e => e.Message.Contains("IGenderedItemGetter", StringComparison.Ordinal))
            .Select(e => e.Message)
            .Distinct()
            .ToList();

        Assert.Equal(20, gendered.Count);
        Assert.All(gendered, m => Assert.Contains("excluded", m, StringComparison.Ordinal));
    }
}
