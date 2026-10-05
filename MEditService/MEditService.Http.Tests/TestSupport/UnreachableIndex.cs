using MEditService.Index;
using MEditService.Ports;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>An Index that fails every question, or refuses a rebuild as another window's hold does,
/// so a test sees what the wire answers for a failure the real Index only has by accident.</summary>
internal sealed class UnreachableIndex(string? rebuildRefusal = null) : IQueryIndex
{
    public LoadOrderStatus Status => throw Failed();

    public (string Sql, string Source)? ActiveFilter => throw Failed();

    public long Sequence => throw Failed();

    public Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout) => throw Failed();

    public IRecordReads RequireReads() => throw Failed();

    public void SetFilter(string sql, string source) => throw Failed();

    public void ClearFilter() => throw Failed();

    public StoreRebuild RebuildStore(GameRelease gameRelease, string instanceRoot) =>
        rebuildRefusal is null ? throw Failed() : new StoreRebuild(Task.CompletedTask, rebuildRefusal);

    internal static void Replace(IServiceCollection services, string? rebuildRefusal = null) =>
        services.AddSingleton<IQueryIndex>(new UnreachableIndex(rebuildRefusal));

    private static InvalidOperationException Failed() => new("The index failed.");
}
