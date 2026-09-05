namespace MEditService.Tests.Api;

/// <summary>Every class that boots a <c>WebApplicationFactory&lt;Program&gt;</c>: two starting at once
/// race on the entry-point host builder and fail with "entry point exited", so they serialize
/// behind one collection while the rest of the suite runs in parallel.</summary>
[CollectionDefinition(Name)]
public sealed class ApiTestCollection
{
    public const string Name = "Web host collection";
}
