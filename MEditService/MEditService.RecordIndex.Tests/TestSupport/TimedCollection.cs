namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Timed tests run alone, after the rest, so no other test's load is in their timings.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class TimedCollection
{
    public const string Name = "Timed";
}
