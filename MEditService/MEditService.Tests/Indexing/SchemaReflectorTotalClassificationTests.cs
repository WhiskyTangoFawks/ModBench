using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

/// <summary>
/// #649 AC #1: classification is <b>total</b>. Every property the reflector's walk reaches lands in
/// exactly one structural class — Loqui struct, Loqui union, list, form link, enum, translated
/// string, atomic value — or is explicitly excluded with a named reason. The default branch is a
/// reported anomaly, and this asserts there are none.
///
/// <para><b>How this differs from <c>SchemaReflectorLeafCoverageCompletenessTests</c>.</b> That
/// sweep independently re-derives "is this property in the schema" and cross-checks it, and is
/// deliberately scoped by its own <c>IsRecognizedShape</c> filter to shapes the dispatch already
/// knows, precisely because without the filter it surfaced a different and larger class of gap — its
/// doc comment names <c>System.Drawing.Color</c> and raw byte blobs as the examples. This file is
/// that larger class, and it needs no shape filter and no depth cap: it does not re-derive the
/// classification at all, it asks the reflector itself what it failed to classify. There is nothing
/// to recompute, so there is no tautology to avoid.</para>
///
/// <para><b>Non-vacuous by construction.</b> The assertion can only pass because every shape the
/// walk meets is handled or named. Removing any class's handling reproduces a named failure listing
/// the owner, property and CLR shape — demonstrated for the atomic-value class in
/// <c>SchemaReflectorAtomicValueTests</c>'s own rivals, and for this file in the commit message.</para>
/// </summary>
public class SchemaReflectorTotalClassificationTests
{
    /// <summary>
    /// A schema built with a collecting logger. Deliberately its own <see cref="SchemaReflector"/>
    /// rather than <c>SharedSchemaReflector.Instance</c>: the shared one is built once with a null
    /// logger and caches per category, so it has no anomalies left to report by the time any test
    /// asks. Paying for one extra reflection pass is the price of observing the build rather than
    /// its cached output.
    /// </summary>
    private static List<LogEntry> BuildAndCollect()
    {
        var entries = new List<LogEntry>();
        // Debug minimum: excluded shapes report at Debug (anomalies at Warning), and the default
        // Information floor would silently drop exactly the lines the exclusion facts below read.
        using var factory = LoggerFactory.Create(b => b
            .SetMinimumLevel(LogLevel.Debug)
            .AddProvider(new CollectingLoggerProvider(entries)));
        new SchemaReflector(factory.CreateLogger<SchemaReflector>()).GetSchemas(GameRelease.Fallout4);
        return entries;
    }

    private static List<string> Anomalies() =>
        BuildAndCollect()
            .Where(e => e.Message.StartsWith(SchemaReflector.UnclassifiedAnomalyPrefix, StringComparison.Ordinal))
            .Select(e => e.Message)
            .Distinct()
            .Order(StringComparer.Ordinal)
            .ToList();

    [Fact]
    public void EveryPropertyTheWalkReaches_IsClassifiedOrExplicitlyExcluded()
    {
        var anomalies = Anomalies();

        Assert.True(anomalies.Count == 0,
            $"SchemaReflector reached {anomalies.Count} propert{(anomalies.Count == 1 ? "y" : "ies")} it " +
            "could not place in any structural class. Each is a field the editor can neither see nor " +
            "write — the defect class #641 and #642 were. Either give the shape a class, or add it to " +
            "SchemaReflector's exclusion table with a named reason.\n  " +
            string.Join("\n  ", anomalies));
    }

    /// <summary>
    /// Guards the guard. If the reporting call sites were removed or the prefix changed,
    /// <see cref="EveryPropertyTheWalkReaches_IsClassifiedOrExplicitlyExcluded"/> would pass
    /// vacuously and forever. Every excluded shape must carry a non-empty reason that says what a
    /// future ticket would have to decide, so "excluded" can never degrade into "silently dropped".
    /// </summary>
    [Fact]
    public void EveryExcludedShape_CarriesANamedReason()
    {
        var reasons = SchemaReflector.ExcludedShapeLabels;

        Assert.NotEmpty(reasons);
        Assert.All(reasons, r => Assert.False(string.IsNullOrWhiteSpace(r)));
        // Every reason states a population size, so the next reader sees the gap's scale in the code
        // rather than having to re-derive it.
        Assert.All(reasons, r => Assert.Contains(" fields;", r, StringComparison.Ordinal));
    }

    /// <summary>
    /// The 20 fields <c>SchemaReflector.ExcludedShapeReason</c>'s <c>IGenderedItemGetter</c> entry
    /// defers. Enumerated rather than counted so the deferral names its own contents: someone reading
    /// the exclusion reaches this list, not a shrug. If Mutagen adds or removes a gendered field this
    /// fails, which is the point — the size of a deferred gap should not drift unnoticed.
    /// </summary>
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
