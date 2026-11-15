using System.Reflection;
using MEditService.RecordIndex.Queries;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>The record index's face, with the writer's wait answered by the test: every other question reaches the real one.</summary>
public class AwaitingQueries : DispatchProxy
{
    private IQueries? _real;
    private Func<long, Task<IndexRefused?>>? _awaiting;

    internal static void Replace(IServiceCollection services, Func<long, Task<IndexRefused?>> awaiting)
    {
        var original = services.Single(service => service.ServiceType == typeof(IQueries));
        services.Remove(original);
        services.AddSingleton(provider =>
        {
            var proxy = Create<IQueries, AwaitingQueries>();
            var queries = (AwaitingQueries)(object)proxy;
            queries._real = (IQueries)original.ImplementationFactory.Require()(provider);
            queries._awaiting = awaiting;
            return proxy;
        });
    }

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        var method = targetMethod.Require();
        if (method.Name == nameof(IQueries.AwaitSourceWritesAfter)) return _awaiting.Require()((long)args.Require()[0].Require());
        try
        {
            return method.Invoke(_real, args);
        }
        catch (TargetInvocationException ex) when (ex.InnerException is not null)
        {
            throw ex.InnerException;
        }
    }
}
