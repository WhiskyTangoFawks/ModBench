using System.Reflection;
using System.Runtime.ExceptionServices;
using MEditService.RecordIndex.Queries;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>The record index's face, with the plugins read parked on its caller's token: the test gets the token, and the
/// read ends when it is cancelled. Every other question reaches the real one.</summary>
public class ParkingQueries : DispatchProxy
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    private IQueries? _real;
    private TaskCompletionSource<CancellationToken>? _parked;

    internal static void Replace(IServiceCollection services, TaskCompletionSource<CancellationToken> parked)
    {
        var original = services.Single(service => service.ServiceType == typeof(IQueries));
        services.Remove(original);
        services.AddSingleton(provider =>
        {
            var proxy = Create<IQueries, ParkingQueries>();
            var queries = (ParkingQueries)(object)proxy;
            queries._real = (IQueries)original.ImplementationFactory.Require()(provider);
            queries._parked = parked;
            return proxy;
        });
    }

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        var method = targetMethod.Require();
        if (method.Name == nameof(IQueries.GetPlugins))
        {
            var cancel = (CancellationToken)args.Require()[1].Require();
            _parked.Require().TrySetResult(cancel);
            Waits.Signalled(cancel.WaitHandle.WaitOne, "the parked read's cancellation", Patience);
            throw new OperationCanceledException(cancel);
        }
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
