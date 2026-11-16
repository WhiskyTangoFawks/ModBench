using System.Reflection;
using System.Runtime.ExceptionServices;
using MEditService.RecordIndex.Queries;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>The record index's face, with a writer's hand answered by the test: every other question reaches the real one.</summary>
public class AwaitingQueries : DispatchProxy
{
    private IQueries? _real;
    private Func<IReadOnlyList<HandedPlugin>?, CancellationToken, Task<string?>>? _holding;

    internal static void Replace(IServiceCollection services, Func<IReadOnlyList<HandedPlugin>?, CancellationToken, Task<string?>> holding)
    {
        var original = services.Single(service => service.ServiceType == typeof(IQueries));
        services.Remove(original);
        services.AddSingleton(provider =>
        {
            var proxy = Create<IQueries, AwaitingQueries>();
            var queries = (AwaitingQueries)(object)proxy;
            queries._real = (IQueries)original.ImplementationFactory.Require()(provider);
            queries._holding = holding;
            return proxy;
        });
    }

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        var method = targetMethod.Require();
        if (method.Name == nameof(IQueries.Hold))
            return _holding.Require()((IReadOnlyList<HandedPlugin>?)args.Require()[0], (CancellationToken)args.Require()[1].Require());
        try
        {
            return method.Invoke(_real, args);
        }
        catch (TargetInvocationException ex) when (ex.InnerException is not null)
        {
            ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
            throw;
        }
    }
}
