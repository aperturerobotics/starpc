package srpc

import "context"

// PrefixClient checks for and strips a set of prefixes from a Client.
type PrefixClient struct {
	// client is the underlying client
	client Client
	// serviceIDPrefixes is the list of service id prefixes to match.
	serviceIDPrefixes []string
}

// NewPrefixClient constructs a new PrefixClient.
//
// serviceIDPrefixes is the list of service id prefixes to match.
// strips the prefix before calling the underlying Invoke function.
// if none of the prefixes match, returns unimplemented.
// if empty: forwards all services w/o stripping any prefix.
func NewPrefixClient(client Client, serviceIDPrefixes []string) *PrefixClient {
	return &PrefixClient{
		client:            client,
		serviceIDPrefixes: serviceIDPrefixes,
	}
}

// ExecCall executes a request/reply RPC with the remote.
func (i *PrefixClient) ExecCall(ctx context.Context, service, method string, in, out Message) error {
	service, err := i.stripCheckServiceIDPrefix(service)
	if err != nil {
		return err
	}
	return i.client.ExecCall(ctx, service, method, in, out)
}

// NewStream starts a streaming RPC with the remote & returns the stream.
// firstMsg is optional.
func (i *PrefixClient) NewStream(ctx context.Context, service, method string, firstMsg Message) (Stream, error) {
	service, err := i.stripCheckServiceIDPrefix(service)
	if err != nil {
		return nil, err
	}
	return i.client.NewStream(ctx, service, method, firstMsg)
}

// stripCheckServiceIDPrefix strips the prefix & returns unimplemented if necessary.
func (i *PrefixClient) stripCheckServiceIDPrefix(service string) (string, error) {
	if len(i.serviceIDPrefixes) != 0 {
		strippedID, matchedPrefix := CheckStripPrefix(service, i.serviceIDPrefixes)
		if len(matchedPrefix) == 0 {
			return service, ErrUnimplemented
		}
		return strippedID, nil
	}
	return service, nil
}

// NewRawStream opens a new raw stream with the remote.
// Implements OpenStreamFunc.
// msgHandler must not be called concurrently.
func (i *PrefixClient) NewRawStream(ctx context.Context, msgHandler PacketDataHandler, closeHandler CloseHandler) (Writer, error) {
	return i.client.NewRawStream(ctx, msgHandler, closeHandler)
}

// _ is a type assertion
var _ Client = ((*PrefixClient)(nil))
