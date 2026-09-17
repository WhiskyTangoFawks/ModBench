namespace MEditService.Tests.TestSupport;

/// <summary>Every class that boots a <c>WebApplicationFactory&lt;Program&gt;</c>: two starting at once
/// race on the entry-point host builder, so they serialize behind one collection while the rest of
/// the suite runs in parallel.</summary>
[CollectionDefinition(Name)]
public sealed class WebHostCollection
{
    public const string Name = "Web host collection";
}
