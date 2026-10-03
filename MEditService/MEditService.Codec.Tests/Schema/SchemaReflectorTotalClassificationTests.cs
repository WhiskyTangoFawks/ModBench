using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Indexing;

public class SchemaReflectorTotalClassificationTests
{
    private static List<LogEntry> BuildAndCollect_PrivateBecauseTheSharedReflectorIsNullLoggedAndCached_DebugBecauseTheDefaultFloorDropsTheseLines()
    {
        var entries = new List<LogEntry>();
        using var factory = LoggerFactory.Create(b => b
            .SetMinimumLevel(LogLevel.Debug)
            .AddProvider(new CollectingLoggerProvider(entries)));
        new SchemaReflector(factory.CreateLogger<SchemaReflector>()).GetSchemas(GameRelease.Fallout4);
        return entries;
    }

    private const string UnclassifiedAnomalyPrefix = "SchemaReflector: unclassified";

    [Fact]
    public void EveryPropertyTheWalkReaches_IsClassifiedOrExplicitlyExcluded_ByAskingTheReflectorWhatItFailedToClassifyNotByReDerivingClassification()
    {
        var entries = BuildAndCollect_PrivateBecauseTheSharedReflectorIsNullLoggedAndCached_DebugBecauseTheDefaultFloorDropsTheseLines();
        Assert.True(entries.Count > 0, "Expected the collector to receive the walk's own trace; a collector wired to nothing would find zero anomalies too.");

        var anomalies = entries
            .Where(e => e.Message.StartsWith(UnclassifiedAnomalyPrefix, StringComparison.Ordinal))
            .Select(e => e.Message)
            .Distinct()
            .Order(StringComparer.Ordinal)
            .ToList();

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
        var gendered = BuildAndCollect_PrivateBecauseTheSharedReflectorIsNullLoggedAndCached_DebugBecauseTheDefaultFloorDropsTheseLines()
            .Where(e => e.Message.Contains("IGenderedItemGetter", StringComparison.Ordinal))
            .Select(e => e.Message)
            .Distinct()
            .ToList();

        Assert.Equal(20, gendered.Count);
        Assert.All(gendered, m => Assert.Contains("excluded", m, StringComparison.Ordinal));
    }
}
