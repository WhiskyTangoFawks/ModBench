namespace MEditService.Core.Plugins;

/// <summary>
/// #605: thrown by <see cref="ILoadOrderMirror.RequireScope"/> — the one place "no load order is
/// held" is thrown now, replacing what used to be a null-check-and-throw re-written at every
/// consumer (<c>WorldspaceQueryService</c>, <c>ContainerChildQueryService</c> and
/// <c>RecordQueryService</c>'s own <c>RequireRepository</c>/<c>RequireLoadOrder</c>, and
/// <see cref="LoadOrderMirror"/>'s own <c>CreatePlugin</c>/<c>ReindexPlugin(PluginKey)</c>/
/// <c>ApplyFilter</c>/<c>RequirePlugin</c>), each with its own copy of the same message.
///
/// <para>Derives from <see cref="InvalidOperationException"/> rather than replacing it as the write
/// endpoints' vocabulary for this failure — every existing <c>catch (InvalidOperationException)</c>
/// (including the ones that observe a different, unrelated mid-operation race inside
/// <c>RecordEditService</c>) keeps compiling and keeps working unchanged, and this flows through
/// <c>WriteEndpointMapping.NoLoadOrder</c> (#604) with no signature change and no second 503 path.
/// </para>
/// </summary>
public sealed class NoLoadOrderException : InvalidOperationException
{
    private const string DefaultMessage = "No load order has been received.";

    public NoLoadOrderException() : base(DefaultMessage)
    {
    }

    public NoLoadOrderException(string message) : base(message)
    {
    }

    public NoLoadOrderException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
